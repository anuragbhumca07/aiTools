const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CBT_COMMANDS_DIR = path.join(CLAUDE_DIR, 'commands', 'cbt');
const CBT_AGENTS_DIR = path.join(CLAUDE_DIR, 'agents');
const CBT_HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');
const CBT_FRAMEWORK_DIR = path.join(CLAUDE_DIR, 'cbt-framework');

const EXPECTED_COMMANDS = [
  'analyze.md', 'build.md', 'clear.md', 'compare.md', 'config.md',
  'deep-analyze.md', 'discover.md', 'eda.md', 'export.md', 'help.md',
  'iterate.md', 'live.md', 'new.md', 'observe.md', 'optimize.md',
  'plan.md', 'plot.md', 'report.md', 'research.md', 'run.md',
  'status.md', 'update.md'
];

const EXPECTED_AGENTS = [
  'cbt-analyzer.md', 'cbt-builder.md', 'cbt-eda.md', 'cbt-researcher.md'
];

const EXPECTED_HOOKS = ['cbt-check-update.js', 'cbt-statusline.js'];

test.describe('CBT Framework Installation', () => {

  test('commands directory exists with all 22 commands', () => {
    expect(fs.existsSync(CBT_COMMANDS_DIR)).toBe(true);
    const installed = fs.readdirSync(CBT_COMMANDS_DIR);
    for (const cmd of EXPECTED_COMMANDS) {
      expect(installed, `Missing command: ${cmd}`).toContain(cmd);
    }
    expect(installed.length).toBeGreaterThanOrEqual(22);
  });

  test('each command file has valid frontmatter with name and description', () => {
    for (const cmd of EXPECTED_COMMANDS) {
      const content = fs.readFileSync(path.join(CBT_COMMANDS_DIR, cmd), 'utf8');
      expect(content, `${cmd} missing frontmatter`).toContain('---');
      expect(content, `${cmd} missing name field`).toContain('name: cbt:');
      expect(content, `${cmd} missing description`).toContain('description:');
    }
  });

  test('all 4 CBT agents are installed', () => {
    expect(fs.existsSync(CBT_AGENTS_DIR)).toBe(true);
    const agents = fs.readdirSync(CBT_AGENTS_DIR);
    for (const agent of EXPECTED_AGENTS) {
      expect(agents, `Missing agent: ${agent}`).toContain(agent);
    }
  });

  test('hooks are installed', () => {
    expect(fs.existsSync(CBT_HOOKS_DIR)).toBe(true);
    const hooks = fs.readdirSync(CBT_HOOKS_DIR);
    for (const hook of EXPECTED_HOOKS) {
      expect(hooks, `Missing hook: ${hook}`).toContain(hook);
    }
  });

  test('framework templates directory exists', () => {
    expect(fs.existsSync(path.join(CBT_FRAMEWORK_DIR, 'templates'))).toBe(true);
    const templates = fs.readdirSync(path.join(CBT_FRAMEWORK_DIR, 'templates'));
    expect(templates.length).toBeGreaterThan(0);
  });

  test('references directory exists', () => {
    expect(fs.existsSync(path.join(CBT_FRAMEWORK_DIR, 'references'))).toBe(true);
  });

  test('engine module exists', () => {
    expect(fs.existsSync(path.join(CBT_FRAMEWORK_DIR, 'engine'))).toBe(true);
    expect(fs.existsSync(path.join(CBT_FRAMEWORK_DIR, 'engine', 'metrics.py'))).toBe(true);
    expect(fs.existsSync(path.join(CBT_FRAMEWORK_DIR, 'engine', '__init__.py'))).toBe(true);
  });

  test('VERSION file is written', () => {
    const versionFile = path.join(CBT_FRAMEWORK_DIR, 'VERSION');
    expect(fs.existsSync(versionFile)).toBe(true);
    const version = fs.readFileSync(versionFile, 'utf8').trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('settings.json contains CBT SessionStart hook', () => {
    const settingsPath = path.join(CLAUDE_DIR, 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    const hasCbtHook = settings.hooks.SessionStart.some(entry =>
      entry.hooks && entry.hooks.some(h =>
        h.command && h.command.includes('cbt-check-update.js')
      )
    );
    expect(hasCbtHook).toBe(true);
  });

  test('GitHub repo page loads correctly', async ({ page }) => {
    await page.goto('https://github.com/Trade-With-Claude/cbt-framework');
    await expect(page).toHaveTitle(/cbt-framework/i);
    // GitHub repo name appears in the visible strong tag inside the breadcrumb header
    await expect(page.locator('[data-pjax="#repo-content-pjax-container"], strong[itemprop="name"], #repository-container-header strong').first()).toBeVisible();
    await page.screenshot({ path: 'tests/cbt-github-verified.png' });
  });
});
