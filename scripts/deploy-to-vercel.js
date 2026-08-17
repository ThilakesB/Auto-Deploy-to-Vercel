#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const http = require('http');
const https = require('https');

const repoName = process.env.GITHUB_REPOSITORY || 'unknown';
const branchName = process.env.GITHUB_REF_NAME || process.env.GITHUB_HEAD_REF || 'unknown';

const REQUIRED_SECRETS = ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID'];

function printFailure(stage, errorMessage, suggestedFix, logs = '') {
  console.log('❌ Deployment Failed');
  console.log('');
  console.log(`Stage: ${stage}`);
  console.log('');
  console.log('Error:');
  console.log(errorMessage);
  console.log('');
  console.log('Suggested Fix:');
  console.log(suggestedFix);
  console.log('');
  console.log('Logs:');
  console.log(logs || 'No logs captured.');
}

function fail(stage, errorMessage, suggestedFix, logs = '') {
  printFailure(stage, errorMessage, suggestedFix, logs);
  process.exit(1);
}

function runCommand(stage, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    shell: false,
    ...options,
  });

  const logs = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();

  if (result.error) {
    fail(stage, result.error.message, `Ensure '${command}' is available in the GitHub Actions runner.`, logs);
  }

  if (result.status !== 0) {
    fail(stage, `${command} ${args.join(' ')} failed with exit code ${result.status}.`, 'Review the logs and fix the underlying project or configuration issue.', logs);
  }

  return logs;
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(process.cwd(), relativePath));
}

function readPackageJson() {
  const packagePath = path.join(process.cwd(), 'package.json');
  if (!fs.existsSync(packagePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch (error) {
    fail('Validation', 'package.json is not valid JSON.', 'Fix package.json syntax errors and retry deployment.', error.message);
  }
}

function detectFramework(pkg) {
  if (!pkg) {
    if (fileExists('index.html') || fileExists('public/index.html')) {
      return 'static';
    }

    fail(
      'Validation',
      'Unable to detect framework because package.json and static index files are missing.',
      'Add a valid package.json for Next.js/React/Vue/Astro or provide index.html for static deployment.'
    );
  }

  const dependencies = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };

  if (dependencies.next) return 'nextjs';
  if (dependencies.astro) return 'astro';
  if (dependencies.vue) return 'vue';
  if (dependencies.react || dependencies['react-dom']) return 'react';
  if (fileExists('index.html') || fileExists('public/index.html')) return 'static';

  fail(
    'Validation',
    'Framework detection failed for this repository.',
    'Ensure dependencies include one of: next, react/react-dom, vue, or astro. For static sites include index.html.'
  );
}

function validateFramework(framework, pkg) {
  if (framework !== 'static' && !pkg) {
    fail('Validation', 'package.json is required for this framework.', 'Add package.json and define dependencies/scripts before deploying.');
  }

  const buildScript = pkg?.scripts?.build;
  if (framework !== 'static' && !buildScript) {
    fail(
      'Validation',
      'Missing build script in package.json.',
      'Add a build script under scripts.build (for example, next build, vite build, or astro build).'
    );
  }

  switch (framework) {
    case 'nextjs': {
      const hasConfig = ['next.config.js', 'next.config.mjs', 'next.config.ts'].some(fileExists);
      const hasAppDir = fileExists('app') || fileExists('pages');
      if (!hasConfig && !hasAppDir) {
        fail(
          'Validation',
          'Next.js project indicators are incomplete (missing next.config.* and app/pages directories).',
          'Ensure this is a valid Next.js project with app/ or pages/ (and optionally next.config.*).'
        );
      }
      break;
    }
    case 'astro': {
      const hasConfig = ['astro.config.mjs', 'astro.config.js', 'astro.config.ts'].some(fileExists);
      if (!hasConfig) {
        fail(
          'Validation',
          'Astro configuration file not found.',
          'Add astro.config.mjs (or .js/.ts) to the project root.'
        );
      }
      break;
    }
    case 'react': {
      const deps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };
      if (!deps.react && !deps['react-dom']) {
        fail('Validation', 'React dependencies are missing.', 'Install react and react-dom dependencies before deploying.');
      }
      break;
    }
    case 'vue': {
      const deps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };
      if (!deps.vue) {
        fail('Validation', 'Vue dependency is missing.', 'Install vue dependency before deploying.');
      }
      break;
    }
    case 'static': {
      if (!fileExists('index.html') && !fileExists('public/index.html')) {
        fail('Validation', 'Static deployment requires index.html.', 'Add index.html at project root or public/index.html.');
      }
      break;
    }
    default:
      fail('Validation', `Unsupported framework: ${framework}`, 'Use Next.js, React, Vue, Astro, or static sites only.');
  }
}

function ensureSecrets() {
  const missing = REQUIRED_SECRETS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    fail(
      'Validation',
      `Missing required secrets: ${missing.join(', ')}`,
      'Set repository secrets VERCEL_TOKEN, VERCEL_ORG_ID, and VERCEL_PROJECT_ID in GitHub settings.'
    );
  }
}

function extractDeploymentUrl(logs) {
  const matches = logs.match(/https:\/\/[a-zA-Z0-9.-]+\.vercel\.app(?:\/[\S]*)?/g);
  if (!matches || matches.length === 0) {
    return null;
  }

  return matches[matches.length - 1];
}

function checkUrlReachable(url, retries = 6, delayMs = 5000) {
  const client = url.startsWith('https') ? https : http;

  return new Promise((resolve, reject) => {
    let attempt = 0;

    const ping = () => {
      attempt += 1;
      const request = client.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 400) {
          resolve({ reachable: true, statusCode: response.statusCode });
          return;
        }

        if (attempt >= retries) {
          reject(new Error(`URL responded with status ${response.statusCode}`));
          return;
        }

        setTimeout(ping, delayMs);
      });

      request.on('error', (error) => {
        if (attempt >= retries) {
          reject(error);
          return;
        }
        setTimeout(ping, delayMs);
      });

      request.setTimeout(10000, () => {
        request.destroy(new Error('Request timed out'));
      });
    };

    ping();
  });
}

async function main() {
  const pkg = readPackageJson();
  const framework = detectFramework(pkg);

  console.log(`Detected framework: ${framework}`);

  validateFramework(framework, pkg);
  ensureSecrets();

  if (framework !== 'static') {
    if (fileExists('package-lock.json')) {
      runCommand('Dependency Installation', 'npm', ['ci']);
    } else {
      runCommand('Dependency Installation', 'npm', ['install']);
    }

    runCommand('Build Process', 'npm', ['run', 'build']);
  }

  const deployLogs = runCommand('Vercel Deployment', 'npx', ['vercel', 'deploy', '--prod', '--yes', '--token', process.env.VERCEL_TOKEN]);
  const deploymentUrl = extractDeploymentUrl(deployLogs);

  if (!deploymentUrl) {
    fail(
      'Vercel Deployment',
      'Vercel deployment completed but deployment URL could not be extracted.',
      'Verify Vercel CLI output format and ensure deployment succeeded with a valid URL.',
      deployLogs
    );
  }

  try {
    await checkUrlReachable(deploymentUrl);
  } catch (error) {
    fail(
      'Vercel Deployment',
      `Deployment URL is not reachable: ${deploymentUrl}`,
      'Check Vercel deployment logs, project configuration, and required environment variables.',
      error.message
    );
  }

  console.log('✅ Deployment Successful');
  console.log('');
  console.log(`Repository: ${repoName}`);
  console.log(`Branch: ${branchName}`);
  console.log('');
  console.log('Live URL:');
  console.log(deploymentUrl);
}

main().catch((error) => {
  fail('Vercel Deployment', error.message, 'Review the logs and configuration, then retry deployment.', error.stack || 'No stack trace available.');
});
