#!/usr/bin/env node
/**
 * create-agenium-agent — scaffold an AGENIUM agent in under 3 minutes
 *
 * Usage:
 *   npx create-agenium-agent                           # interactive
 *   npx create-agenium-agent my-agent                   # name from arg
 *   npx create-agenium-agent my-agent --template=echo   # skip template prompt
 *   npx create-agenium-agent my-agent --yes             # all defaults, no prompts
 */

import prompts from 'prompts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, '..', 'templates');

interface Config {
  name: string;
  description: string;
  template: 'echo' | 'tools' | 'api';
  port: number;
  dnsServer: string;
  installDeps: boolean;
  initGit: boolean;
}

const TEMPLATES: Record<string, { label: string; desc: string }> = {
  echo:  { label: 'Echo Agent',       desc: 'Minimal agent — echo, ping, info tools' },
  tools: { label: 'Custom Tools',     desc: 'Agent with example custom tools (starter)' },
  api:   { label: 'API Wrapper',      desc: 'Wraps an external REST API as agent tools' },
};

function banner() {
  console.log(`
  ╔═══════════════════════════════════════════════════╗
  ║   🤖  create-agenium-agent                       ║
  ║   Build your first agent:// in under 3 minutes   ║
  ╚═══════════════════════════════════════════════════╝
`);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function parseFlags(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [key, ...rest] = a.slice(2).split('=');
      flags[key] = rest.length ? rest.join('=') : true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function run() {
  banner();

  const { positional, flags } = parseFlags(process.argv.slice(2));
  const isYes = !!flags['yes'] || !!flags['y'];
  const argName = positional[0] ? slugify(positional[0]) : undefined;
  const argTemplate = typeof flags['template'] === 'string' ? flags['template'] : undefined;
  const argPort = typeof flags['port'] === 'string' ? parseInt(flags['port']) : undefined;
  const noInstall = !!flags['no-install'];
  const noGit = !!flags['no-git'];

  let config: Config;

  if (isYes) {
    // Non-interactive: use args + defaults
    config = {
      name: argName || 'my-agent',
      template: (argTemplate as Config['template']) || 'echo',
      description: 'My AGENIUM agent',
      port: argPort || 9001,
      dnsServer: '185.204.169.26:3000',
      installDeps: !noInstall,
      initGit: !noGit,
    };
  } else {
    // Interactive prompts
    let cancelled = false;
    const onCancel = () => { cancelled = true; };

    const response = await prompts([
      {
        type: argName ? null : 'text',
        name: 'name',
        message: 'Agent name',
        initial: 'my-agent',
        validate: (v: string) => /^[a-z0-9-]+$/.test(v) || 'lowercase letters, numbers, hyphens only',
      },
      {
        type: argTemplate ? null : 'select',
        name: 'template',
        message: 'Template',
        choices: Object.entries(TEMPLATES).map(([value, { label, desc }]) => ({
          title: `${label} — ${desc}`,
          value,
        })),
      },
      {
        type: 'text',
        name: 'description',
        message: 'Description',
        initial: 'My AGENIUM agent',
      },
      {
        type: 'number',
        name: 'port',
        message: 'Listen port',
        initial: 9001,
      },
      {
        type: 'confirm',
        name: 'installDeps',
        message: 'Install dependencies now?',
        initial: true,
      },
      {
        type: 'confirm',
        name: 'initGit',
        message: 'Initialize git repo?',
        initial: true,
      },
    ], { onCancel });

    if (cancelled) {
      console.log('\n  Cancelled.\n');
      process.exit(1);
    }

    config = {
      name: slugify(argName ?? response.name ?? 'my-agent'),
      template: (argTemplate ?? response.template ?? 'echo') as Config['template'],
      description: response.description ?? 'My AGENIUM agent',
      port: argPort ?? response.port ?? 9001,
      dnsServer: '185.204.169.26:3000',
      installDeps: noInstall ? false : (response.installDeps ?? true),
      initGit: noGit ? false : (response.initGit ?? true),
    };
  }

  if (!TEMPLATES[config.template]) {
    console.error(`\n  ❌ Unknown template "${config.template}". Choose: ${Object.keys(TEMPLATES).join(', ')}\n`);
    process.exit(1);
  }

  const targetDir = path.resolve(process.cwd(), config.name);

  if (fs.existsSync(targetDir)) {
    console.error(`\n  ❌ Directory "${config.name}" already exists.\n`);
    process.exit(1);
  }

  console.log(`  📦 Creating ${config.name} (${TEMPLATES[config.template].label})...\n`);

  // Create directory structure
  fs.mkdirSync(path.join(targetDir, 'src'), { recursive: true });

  // Write package.json
  const pkg = {
    name: config.name,
    version: '0.1.0',
    description: config.description,
    type: 'module',
    main: 'dist/index.js',
    scripts: {
      build: 'tsc',
      start: 'node dist/index.js',
      dev: 'npx tsx src/index.ts',
      'docker:build': `docker build -t ${config.name} .`,
      'docker:run': `docker run -p ${config.port}:${config.port} --env-file .env ${config.name}`,
    },
    dependencies: {
      agenium: '^0.2.0',
    },
    devDependencies: {
      '@types/node': '^22.0.0',
      typescript: '^5.5.0',
      tsx: '^4.0.0',
    },
  };
  writeFile(targetDir, 'package.json', JSON.stringify(pkg, null, 2));

  // tsconfig.json
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'Node16',
      moduleResolution: 'Node16',
      outDir: 'dist',
      rootDir: 'src',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      declaration: true,
    },
    include: ['src'],
  };
  writeFile(targetDir, 'tsconfig.json', JSON.stringify(tsconfig, null, 2));

  // Copy template source
  const templateSrc = fs.readFileSync(
    path.join(TEMPLATES_DIR, config.template, 'index.ts'),
    'utf-8',
  );
  writeFile(targetDir, 'src/index.ts', applyVars(templateSrc, config));

  // Shared base files
  writeFile(targetDir, '.env.example', generateEnvExample(config));
  writeFile(targetDir, '.env', generateEnvExample(config));
  writeFile(targetDir, '.gitignore', GITIGNORE);
  writeFile(targetDir, 'Dockerfile', generateDockerfile(config));
  writeFile(targetDir, 'README.md', generateReadme(config));

  console.log('\n  ✅ Files created\n');

  // Install deps
  if (config.installDeps) {
    console.log('  📥 Installing dependencies...\n');
    try {
      execSync('npm install', { cwd: targetDir, stdio: 'inherit' });
      console.log('\n  ✅ Dependencies installed\n');
    } catch {
      console.log('\n  ⚠️  npm install failed — run it manually\n');
    }
  }

  // Init git
  if (config.initGit) {
    try {
      execSync('git init && git add -A && git commit -m "feat: initial agent scaffold"', {
        cwd: targetDir,
        stdio: 'pipe',
      });
      console.log('  ✅ Git initialized\n');
    } catch {
      // git might not be available
    }
  }

  // Done!
  console.log(`  🎉 Done! Your agent is ready.\n`);
  console.log(`  Next steps:\n`);
  console.log(`    cd ${config.name}`);
  console.log(`    npm run dev          # Start in dev mode`);
  console.log(`    npm run build        # Compile TypeScript`);
  console.log(`    npm start            # Run compiled agent`);
  console.log(`    npm run docker:build # Build Docker image`);
  console.log('');
  console.log(`  📖 Docs: https://docs.agenium.net/quickstart`);
  console.log(`  💬 Help: https://discord.gg/agenium\n`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function writeFile(dir: string, name: string, content: string) {
  const fp = path.join(dir, name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
  console.log(`    + ${name}`);
}

function applyVars(template: string, config: Config): string {
  return template
    .replace(/\{\{NAME\}\}/g, config.name)
    .replace(/\{\{DESCRIPTION\}\}/g, config.description)
    .replace(/\{\{PORT\}\}/g, String(config.port))
    .replace(/\{\{DNS_SERVER\}\}/g, config.dnsServer);
}

function generateEnvExample(config: Config): string {
  return `# ${config.name} — agent configuration
PORT=${config.port}
DNS_SERVER=${config.dnsServer}
DNS_API_KEY=          # Get from marketplace.agenium.net
PUBLIC_HOST=localhost  # Your public hostname/IP
`;
}

function generateDockerfile(config: Config): string {
  return `FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
ENV PORT=${config.port}
EXPOSE ${config.port}
CMD ["node", "dist/index.js"]
`;
}

function generateReadme(config: Config): string {
  return `# ${config.name}

${config.description}

Built with [AGENIUM](https://agenium.net) — the agent-to-agent protocol.

## Quick Start

\`\`\`bash
# Development (hot reload)
npm run dev

# Production
npm run build
npm start

# Docker
npm run docker:build
npm run docker:run
\`\`\`

## Configuration

Copy \`.env.example\` to \`.env\` and fill in your values:

| Variable | Description | Default |
|----------|-------------|---------|
| \`PORT\` | Agent listen port | ${config.port} |
| \`DNS_SERVER\` | AGENIUM DNS server | ${config.dnsServer} |
| \`DNS_API_KEY\` | API key from marketplace | — |
| \`PUBLIC_HOST\` | Your public hostname/IP | localhost |

## DNS Registration

To make your agent discoverable as \`agent://${config.name}\`:

1. Get an API key from [marketplace.agenium.net](https://marketplace.agenium.net)
2. Set \`DNS_API_KEY\` in your \`.env\`
3. Set \`PUBLIC_HOST\` to your server's public IP/domain
4. Start the agent — it auto-registers on boot

## Learn More

- 📖 [Documentation](https://docs.agenium.net)
- 🤖 [AGENIUM Protocol](https://agenium.net)
- 💬 [Discord Community](https://discord.gg/agenium)
`;
}

const GITIGNORE = `node_modules/
dist/
.env
*.tgz
.DS_Store
`;

run().catch((err) => {
  console.error('  ❌ Fatal error:', err.message);
  process.exit(1);
});
