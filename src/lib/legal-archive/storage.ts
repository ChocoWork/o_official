import { sha256 } from './manifest';

export interface ArchiveStorage {
  readonly name: string;
  putTemporary(key: string, body: Uint8Array, contentType: string): Promise<void>;
  promote(temporaryKey: string, finalKey: string, immutable: boolean): Promise<void>;
  exists(key: string): Promise<boolean>;
  read(key: string): Promise<Uint8Array>;
  removeTemporary(prefix: string): Promise<void>;
}

function contentType(name: string): string {
  if (name.endsWith('.csv')) return 'text/csv; charset=utf-8';
  if (name.endsWith('.json')) return 'application/json; charset=utf-8';
  if (name.endsWith('.gz')) return 'application/gzip';
  return 'application/octet-stream';
}

export async function storeArchiveAtomically(input: {
  artifacts: Record<string, Uint8Array>;
  targets: ArchiveStorage[];
  finalPrefix: string;
  runId: string;
  immutable: boolean;
  buildManifest(targets: Array<{ name: string; verified: true }>): Uint8Array;
}) {
  if (input.targets.length === 0) throw new Error('At least one archive target is required');
  const stagingPrefix = `_staging/${input.runId}`;
  const names = Object.keys(input.artifacts).sort();
  const targetResults = input.targets
    .map((target) => ({ name: target.name, verified: true as const }))
    .sort((a, b) => a.name.localeCompare(b.name));

  try {
    for (const target of input.targets) {
      for (const name of [...names, 'manifest.json']) {
        if (input.immutable && await target.exists(`${input.finalPrefix}/${name}`)) {
          throw new Error(`Immutable archive key already exists: ${target.name}/${name}`);
        }
      }
    }

    for (const target of input.targets) {
      for (const name of names) {
        const body = input.artifacts[name];
        const key = `${stagingPrefix}/${name}`;
        await target.putTemporary(key, body, contentType(name));
        const stored = await target.read(key);
        if (sha256(stored) !== sha256(body)) {
          throw new Error(`Archive verification failed: ${target.name}/${name}`);
        }
      }
    }

    const manifest = input.buildManifest(targetResults);
    for (const target of input.targets) {
      const key = `${stagingPrefix}/manifest.json`;
      await target.putTemporary(key, manifest, contentType('manifest.json'));
      if (sha256(await target.read(key)) !== sha256(manifest)) {
        throw new Error(`Archive manifest verification failed: ${target.name}`);
      }
    }

    for (const target of input.targets) {
      for (const name of [...names, 'manifest.json']) {
        await target.promote(
          `${stagingPrefix}/${name}`,
          `${input.finalPrefix}/${name}`,
          input.immutable,
        );
      }
    }

    return { targets: targetResults, manifestSha256: sha256(manifest) };
  } finally {
    await Promise.allSettled(
      input.targets.map((target) => target.removeTemporary(stagingPrefix)),
    );
  }
}
