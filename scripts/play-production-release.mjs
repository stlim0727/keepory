// Inspect Play tracks or promote one exact internal build with localized notes.
// No dependencies; Node 22+. No automatic retries of Play writes.
import { readFile } from 'node:fs/promises';
import { sign } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const PACKAGE = 'com.keepory.app';
const BASE = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const canonical = (value) => JSON.stringify([...value].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
const codes = (track) => (track?.releases ?? []).flatMap((r) => r.versionCodes ?? []);

function releasePayload({ version, code, notes }) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Use a stable X.Y.Z version.');
  if (!/^[1-9]\d*$/.test(code ?? '')) throw new Error('Specify the exact positive version code.');
  if (!Array.isArray(notes) || notes.length !== 2 ||
      canonical(notes.map((n) => n.language)) !== canonical(['en-US', 'ko-KR']) ||
      notes.some((n) => typeof n.text !== 'string' || !n.text.trim() || Array.from(n.text).length > 500)) {
    throw new Error('Notes must contain separate nonempty en-US and ko-KR texts, each <=500 characters.');
  }
  return { name: version, versionCodes: [code], status: 'completed',
    releaseNotes: notes.map(({ language, text }) => ({ language, text })) };
}

export function planPromotion(tracks, options) {
  const { version, code, expectedProductionCodes } = options;
  const release = releasePayload(options);
  const production = tracks.find((t) => t.track === 'production');
  const alreadyPublished = production?.releases?.length === 1 &&
    production.releases[0].name === version && production.releases[0].status === 'completed' &&
    canonical(codes(production)) === canonical([code]) &&
    canonical(production.releases[0].releaseNotes ?? []) === canonical(release.releaseNotes);
  if (alreadyPublished) return { release, alreadyPublished: true };
  if ((production?.releases ?? []).some((r) => r.status !== 'completed') ||
      (production?.releases ?? []).length > 1) {
    throw new Error('Staged, halted, draft, or multiple production releases require a separate reviewed rollout plan.');
  }
  if (!Array.isArray(expectedProductionCodes) ||
      canonical(codes(production)) !== canonical(expectedProductionCodes)) {
    throw new Error('Production changed or expected production codes are missing. Inspect tracks again; do not overwrite blindly.');
  }
  const source = tracks.find((t) => t.track === 'internal')?.releases?.find((r) =>
    r.name === version && r.status === 'completed' && canonical(r.versionCodes ?? []) === canonical([code]));
  if (!source) throw new Error('Expected exact completed internal version and code not found.');
  if (codes(production).some((c) => BigInt(c) >= BigInt(code))) {
    throw new Error('Production has an equal or newer version code.');
  }
  return { release, alreadyPublished: false };
}

export async function publisher(credentialsPath) {
  const key = JSON.parse(await readFile(credentialsPath, 'utf8'));
  if (key.type !== 'service_account' || !key.client_email || !key.private_key) {
    throw new Error('Expected a Google service-account credential file.');
  }
  const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const jwt = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: key.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })}`;
  const assertion = `${jwt}.${sign('RSA-SHA256', Buffer.from(jwt), key.private_key).toString('base64url')}`;
  const auth = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', signal: AbortSignal.timeout(30000),
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!auth.ok) throw new Error(`Google authentication failed (${auth.status}); check credential binding and access.`);
  const { access_token: token } = await auth.json();
  if (!token) throw new Error('Google authentication returned no access token.');
  return async (suffix, method = 'GET', data) => {
    const response = await fetch(BASE + suffix, {
      method, signal: AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`Play API ${method} failed (${response.status}): ${await response.text()}`);
    return response.status === 204 ? undefined : response.json();
  };
}

export async function withEdit(api, action) {
  const { id } = await api('/edits', 'POST', {});
  let committed = false;
  try {
    return await action(`/edits/${id}`, async () => {
      // A lost commit response is ambiguous: inspect production before retrying.
      const result = await api(`/edits/${id}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`, 'POST');
      committed = true;
      return result;
    });
  } finally {
    if (!committed) {
      try { await api(`/edits/${id}`, 'DELETE'); }
      catch { console.error('Could not delete temporary edit; it will expire.'); }
    }
  }
}

export async function runRelease(api, options) {
  // Summaries can be read without opening/invalidation of any publisher edit.
  if (options.command === 'inspect' || !options.commit) {
    const summaries = await Promise.all(['production', 'internal'].map(async (track) => ({
      track, ...await api(`/tracks/${track}/releases`),
    })));
    return options.command === 'inspect' ? { summaries } : {
      summaries, release: releasePayload(options), committed: false, provisional: true,
    };
  }
  if (!options.publisherIdle) throw new Error('Verify all publisher operations are idle, then pass --publisher-idle before opening an edit.');
  const result = await withEdit(api, async (edit, commit) => {
    const { tracks } = await api(`${edit}/tracks`);
    const plan = planPromotion(tracks, options);
    if (plan.alreadyPublished || !options.commit) return { ...plan, committed: false };
    await api(`${edit}/tracks/production`, 'PUT', { track: 'production', releases: [plan.release] });
    await api(`${edit}:validate`, 'POST');
    await commit();
    return { ...plan, committed: true };
  });
  if (result.committed) {
    await withEdit(api, async (edit) => {
      const { tracks } = await api(`${edit}/tracks`);
      if (!planPromotion(tracks, options).alreadyPublished) {
        throw new Error('Commit returned success but production readback differs. Inspect before any retry.');
      }
    });
    result.verified = true;
  }
  return result;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    credentials: { type: 'string' }, version: { type: 'string' }, code: { type: 'string' },
    'expected-production-codes': { type: 'string' }, notes: { type: 'string' },
    commit: { type: 'boolean', default: false }, 'publisher-idle': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('Usage: node scripts/play-production-release.mjs inspect|promote --credentials PATH\n' +
      'promote: --version X.Y.Z --code N --expected-production-codes N[,N] --notes PATH [--commit --publisher-idle]\n' +
      'Without --commit, promote only prints the plan. Notes: [{language:"en-US",text:"..."},{language:"ko-KR",text:"..."}].');
    return;
  }
  const command = positionals[0];
  if (!['inspect', 'promote'].includes(command) || positionals.length !== 1) throw new Error('Use inspect or promote; see --help.');
  const credentials = values.credentials || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentials) throw new Error('Set --credentials or GOOGLE_APPLICATION_CREDENTIALS to the publisher key path.');
  const options = { command, commit: values.commit, version: values.version, code: values.code, publisherIdle: values['publisher-idle'] };
  if (command === 'promote') {
    options.notes = JSON.parse(await readFile(values.notes, 'utf8'));
    options.expectedProductionCodes = values['expected-production-codes']?.split(',').filter(Boolean);
    releasePayload(options);
    if (!options.expectedProductionCodes || options.expectedProductionCodes.some((c) => !/^[1-9]\d*$/.test(c))) {
      throw new Error('Specify --expected-production-codes from a fresh inspection (empty string for no releases).');
    }
  } else if (values.commit) throw new Error('--commit is only valid for promote.');
  console.log(JSON.stringify(await runRelease(await publisher(credentials), options), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
