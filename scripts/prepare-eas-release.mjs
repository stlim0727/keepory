// scripts/prepare-eas-release.mjs
// Synchronizes mobile app versioning between APK and EAS builds,
// guards against version regression, and generates Play Store release notes.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Parses a semantic version string.
 * Supports X.Y.Z and X.Y.Z-prerelease (e.g. 1.2.5, 1.2.5-rc1).
 */
export function parseSemVer(v) {
  if (!v || typeof v !== 'string') return null;
  const clean = v.trim().replace(/^v/, '');
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  const patch = parseInt(match[3], 10);
  const prerelease = match[4] || null;
  return { raw: clean, major, minor, patch, prerelease };
}

/**
 * Compares two SemVer versions.
 * Returns 1 if v1 > v2, -1 if v1 < v2, and 0 if v1 === v2.
 * Rule: Stable releases are greater than prereleases (1.2.5 > 1.2.5-rc1).
 * Prerelease rc tags are compared numerically (rc10 > rc2).
 */
export function compareSemVer(v1, v2) {
  const p1 = typeof v1 === 'string' ? parseSemVer(v1) : v1;
  const p2 = typeof v2 === 'string' ? parseSemVer(v2) : v2;
  if (!p1 && !p2) return 0;
  if (!p1) return -1;
  if (!p2) return 1;

  if (p1.major !== p2.major) return p1.major > p2.major ? 1 : -1;
  if (p1.minor !== p2.minor) return p1.minor > p2.minor ? 1 : -1;
  if (p1.patch !== p2.patch) return p1.patch > p2.patch ? 1 : -1;

  if (!p1.prerelease && p2.prerelease) return 1;
  if (p1.prerelease && !p2.prerelease) return -1;
  if (!p1.prerelease && !p2.prerelease) return 0;

  const parts1 = p1.prerelease.split(/[.-]/);
  const parts2 = p2.prerelease.split(/[.-]/);
  const maxLen = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLen; i++) {
    const part1 = parts1[i] ?? '';
    const part2 = parts2[i] ?? '';

    const rc1 = part1.match(/^rc(\d+)$/);
    const rc2 = part2.match(/^rc(\d+)$/);
    if (rc1 && rc2) {
      const n1 = parseInt(rc1[1], 10);
      const n2 = parseInt(rc2[1], 10);
      if (n1 !== n2) return n1 > n2 ? 1 : -1;
      continue;
    }

    const num1 = /^\d+$/.test(part1) ? parseInt(part1, 10) : null;
    const num2 = /^\d+$/.test(part2) ? parseInt(part2, 10) : null;
    if (num1 !== null && num2 !== null) {
      if (num1 !== num2) return num1 > num2 ? 1 : -1;
    } else {
      if (part1 !== part2) return part1.localeCompare(part2);
    }
  }

  return 0;
}

/**
 * Collects all known released or built versions across Git tags, GitHub releases,
 * dev release markers, and app.json.
 */
export function collectKnownVersions({ gitTags = [], githubReleases = [], appVersion = null, devReleaseBody = '' }) {
  const versions = new Set();
  if (appVersion && parseSemVer(appVersion)) {
    versions.add(parseSemVer(appVersion).raw);
  }

  for (const tag of gitTags) {
    const p = parseSemVer(tag);
    if (p) versions.add(p.raw);
  }

  for (const rel of githubReleases) {
    const p = parseSemVer(rel);
    if (p) versions.add(p.raw);
  }

  if (devReleaseBody) {
    const rcMatch = devReleaseBody.match(/rc-state:\s*(v?\d+\.\d+\.\d+(?:-rc\d+)?)/);
    if (rcMatch && parseSemVer(rcMatch[1])) {
      versions.add(parseSemVer(rcMatch[1]).raw);
    }
  }

  return Array.from(versions)
    .sort(compareSemVer);
}

/**
 * Resolves the target build version and enforces the minimum version guard.
 */
export function resolveVersionWithGuard({ inputVersion, appVersion, knownVersions = [] }) {
  const sortedKnown = [...knownVersions].sort(compareSemVer);
  const latestKnown = sortedKnown[sortedKnown.length - 1] || appVersion;

  if (inputVersion && inputVersion.trim() !== '') {
    const parsedInput = parseSemVer(inputVersion);
    if (!parsedInput) {
      throw new Error(`Invalid version format: '${inputVersion}'. Must be SemVer (e.g. 1.2.5 or v1.2.5-rc1).`);
    }

    // Version Guard: User requested version must be >= latest known built/released version
    if (compareSemVer(parsedInput.raw, latestKnown) < 0) {
      throw new Error(
        `Version regression rejected! Requested version '${parsedInput.raw}' is lower than latest known released/built version '${latestKnown}'. ` +
        `EAS build requires a version >= '${latestKnown}'.`
      );
    }

    return {
      version: parsedInput.raw,
      latestKnown,
      isAutoResolved: false,
    };
  }

  // When input is blank, choose the maximum of app.json version and latest known version
  const resolved = compareSemVer(appVersion, latestKnown) >= 0 ? appVersion : latestKnown;
  return {
    version: resolved,
    latestKnown,
    isAutoResolved: true,
  };
}

/**
 * Formats Play Store release notes ensuring strict <= 500 characters UTF-8 limit.
 */
export function formatPlayStoreReleaseNotes({ rawMarkdown = '', gitCommits = [], maxLength = 500 }) {
  const bulletItems = [];

  if (rawMarkdown && rawMarkdown.trim() !== '') {
    const lines = rawMarkdown.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // Match markdown bullet lines (- [ ], - [x], - item, * item)
      if (/^[-*]\s+(\[[ xX]\]\s+)?/.test(trimmed)) {
        const cleaned = trimmed
          .replace(/^[-*]\s+(\[[ xX]\]\s+)?/, '')
          .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1') // Strip markdown links, keep text
          .replace(/[`*_~]/g, '')                     // Strip markdown emphasis
          .replace(/\s+/g, ' ')
          .trim();

        if (cleaned.length > 3) {
          bulletItems.push(`• ${cleaned}`);
        }
      }
    }
  }

  // Fallback to git commits if no bullet items were found in markdown
  if (bulletItems.length === 0 && gitCommits.length > 0) {
    for (const commit of gitCommits) {
      const clean = commit
        .replace(/^[a-f0-9]+\s+/, '')
        .replace(/\s*\(#\d+\)$/, '')
        .trim();
      if (/^(feat|fix|perf|refactor)/i.test(clean)) {
        bulletItems.push(`• ${clean}`);
      }
    }
  }

  // Default fallback if still empty
  if (bulletItems.length === 0) {
    bulletItems.push('• 앱 안정성 향상 및 버그 수정');
    bulletItems.push('• 성능 최적화');
  }

  // Assemble within maxLength
  let result = '';
  for (const item of bulletItems) {
    const candidate = result ? `${result}\n${item}` : item;
    if (candidate.length <= maxLength) {
      result = candidate;
    } else {
      break;
    }
  }

  if (!result) {
    result = bulletItems[0].slice(0, maxLength);
  }

  return result;
}

/**
 * Main execution for CI
 */
export async function run() {
  const appJsonPath = path.join(REPO_ROOT, 'apps/mobile/app.json');
  const easJsonPath = path.join(REPO_ROOT, 'apps/mobile/eas.json');

  if (!fs.existsSync(appJsonPath)) {
    throw new Error(`app.json not found at ${appJsonPath}`);
  }
  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  const appVersion = appJson.expo?.version || '1.0.0';

  // 1. Collect Git tags
  let gitTags = [];
  try {
    const tagOutput = execSync('git tag -l "v*"', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    gitTags = tagOutput.split('\n').map(t => t.trim()).filter(Boolean);
  } catch {
    // Git tags might not be available or shallow clone without tags
  }

  // 2. Collect GitHub Releases & dev release body
  let githubReleases = [];
  let devReleaseBody = '';
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo && process.env.GH_TOKEN) {
    try {
      const relOutput = execSync(`gh api repos/${repo}/releases --jq '.[].tag_name'`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      githubReleases = relOutput.split('\n').map(t => t.trim()).filter(Boolean);
    } catch {
      // gh CLI may not be available or network error
    }

    try {
      const devOutput = execSync(`gh api repos/${repo}/releases/tags/dev --jq '.body'`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      devReleaseBody = devOutput;
    } catch {
      // dev release may not exist
    }
  }

  const knownVersions = collectKnownVersions({ gitTags, githubReleases, appVersion, devReleaseBody });
  console.log(`[prepare-eas-release] Known versions across Git & Releases: ${knownVersions.join(', ')}`);

  // 3. Resolve target version with Guard
  const inputVersion = process.env.INPUT_VERSION || '';
  const { version: targetVersion, latestKnown, isAutoResolved } = resolveVersionWithGuard({
    inputVersion,
    appVersion,
    knownVersions,
  });

  console.log(
    `[prepare-eas-release] Target version: ${targetVersion} ` +
    `(input: '${inputVersion || '<blank>'}', app.json: '${appVersion}', latest known: '${latestKnown}', autoResolved: ${isAutoResolved})`
  );

  // 4. Update eas.json
  if (fs.existsSync(easJsonPath)) {
    const easJson = JSON.parse(fs.readFileSync(easJsonPath, 'utf8'));
    easJson.build = easJson.build || {};
    easJson.build.production = easJson.build.production || {};
    easJson.build.production.env = {
      ...(easJson.build.production.env || {}),
      APP_VERSION: targetVersion,
    };
    fs.writeFileSync(easJsonPath, JSON.stringify(easJson, null, 2) + '\n', 'utf8');
    console.log(`[prepare-eas-release] Updated apps/mobile/eas.json production.env.APP_VERSION to ${targetVersion}`);
  }

  // 5. Look for release notes in docs/release-notes/
  let rawMarkdown = '';
  const candidateDocPaths = [
    path.join(REPO_ROOT, `docs/release-notes/v${targetVersion}.md`),
    path.join(REPO_ROOT, `docs/release-notes/${targetVersion}.md`),
    path.join(REPO_ROOT, `docs/release-notes/v${targetVersion}-rc1.md`),
  ];

  for (const docPath of candidateDocPaths) {
    if (fs.existsSync(docPath)) {
      rawMarkdown = fs.readFileSync(docPath, 'utf8');
      console.log(`[prepare-eas-release] Found release notes documentation at ${docPath}`);
      break;
    }
  }

  // Collect git commits if markdown is missing
  let gitCommits = [];
  try {
    const lastTag = execSync('git describe --tags --abbrev=0 2>/dev/null || echo ""', { encoding: 'utf8' }).trim();
    const gitRange = lastTag ? `${lastTag}..HEAD` : 'HEAD~10..HEAD';
    const commitOutput = execSync(`git log ${gitRange} --oneline --no-merges`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    gitCommits = commitOutput.split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    // Ignore git log errors
  }

  // 6. Generate Play Store formatted notes (<= 500 chars)
  const playStoreNotes = formatPlayStoreReleaseNotes({ rawMarkdown, gitCommits, maxLength: 500 });
  const charCount = playStoreNotes.length;
  console.log(`[prepare-eas-release] Play Store release notes generated (${charCount}/500 chars):\n${playStoreNotes}`);

  // 7. Write to Fastlane changelog paths for Play Store submission
  const fastlaneDirs = [
    path.join(REPO_ROOT, 'apps/mobile/fastlane/metadata/android/ko-KR/changelogs'),
    path.join(REPO_ROOT, 'apps/mobile/fastlane/metadata/android/en-US/changelogs'),
  ];
  for (const dir of fastlaneDirs) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'default.txt'), playStoreNotes + '\n', 'utf8');
  }
  console.log(`[prepare-eas-release] Wrote Fastlane default.txt changelogs`);

  // Write standalone file in dist/
  const distDir = path.join(REPO_ROOT, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'play-store-release-notes.txt'), playStoreNotes + '\n', 'utf8');

  // 8. GitHub Step Summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summaryMd = [
      `### 🚀 EAS Play Store Release: **v${targetVersion}**`,
      `- **Target App Version**: \`${targetVersion}\``,
      `- **Latest Known Built/Released Version**: \`${latestKnown}\``,
      `- **Version Selection**: ${isAutoResolved ? '⚡ Auto-synchronized from latest build/app.json' : '✍️ Explicit dispatch input'}`,
      '',
      `### 📱 Google Play Release Notes (${charCount}/500자)`,
      '> Google Play Console 릴리즈 시 복사해서 붙여넣을 수 있는 500자 이내 릴리즈 노트입니다:',
      '```text',
      playStoreNotes,
      '```',
      '',
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMd + '\n');
  }

  // 9. GitHub Output
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${targetVersion}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
