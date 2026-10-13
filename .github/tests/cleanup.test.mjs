import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import bytes from 'bytes';
import lodash from 'lodash';
import ts from 'typescript';

const source = ts.transpileModule(await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText;

const artifacts = [1, 2, 3].map((number) => ({
  id: number,
  name: `artifact-${number}`,
  size_in_bytes: 1024 * 1024,
  workflow_run: { id: 100 + number },
  created_at: `2026-01-0${number}T00:00:00Z`
}));

async function runAction(inputs = {}, options = {}) {
  const deleted = [];
  const zipped = [];
  const unlinked = [];
  const warnings = [];
  const queries = [];
  let failure;
  let loggedError;
  let finish;
  const completed = new Promise((resolve) => {
    finish = resolve;
  });
  const values = {
    token: 'test-token',
    limit: '3MB',
    fixedReservedSize: '1MB',
    removeDirection: 'oldest',
    simulateCompressionLevel: '0',
    failOnError: 'true',
    ...inputs
  };
  class ArtifactNotFoundError extends Error {}
  const modules = {
    'node:fs/promises': {
      stat: async () => ({ size: options.zipSize ?? 1024 * 1024 }),
      unlink: async (path) => {
        unlinked.push(path);
      }
    },
    '@actions/artifact': {
      ArtifactNotFoundError,
      default: {
        deleteArtifact: async (name, config) => {
          deleted.push({ name, ...config.findBy });
          if (options.notFound === name) throw new ArtifactNotFoundError('Artifact expired');
          if (options.deleteError) throw new Error('Deletion failed');
        }
      }
    },
    '@actions/core': {
      getInput: (name) => values[name] ?? '',
      getMultilineInput: () => options.paths ?? [],
      getBooleanInput: (name) => values[name] === 'true',
      info: (message) => {
        if (message === 'Artifacts cleanup action completed successfully') finish();
      },
      warning: (message) => {
        warnings.push(message);
      },
      setFailed: (message) => {
        failure = message;
        finish();
      },
      error: (message) => {
        loggedError = message;
        finish();
      }
    },
    '@actions/github': {
      getOctokit: () => ({
        rest: { actions: { listArtifactsForRepo: { endpoint: { merge: (query) => query } } } },
        paginate: async (query, map) => {
          queries.push({ ...query });
          return map({ data: options.artifacts ?? artifacts });
        }
      })
    },
    '@octokit/plugin-retry': { retry: () => {} },
    '@octokit/plugin-throttling': { throttling: () => {} },
    bytes: { default: bytes },
    lodash: { default: lodash },
    'pretty-error': {
      default: class {
        render(error) {
          return error.message;
        }
      }
    },
    uuid: { v4: () => 'test-id' },
    './utils': {
      Utils: {
        expandPaths: async (paths) => paths,
        checkPathExists: async (path) => !(options.missingPaths ?? []).includes(path),
        createZipFile: async (path, destination, compression) => {
          zipped.push({ path, destination, compression });
          if (options.zipError) throw new Error('ZIP failed');
          return destination;
        }
      }
    }
  };
  const context = createContext({ process: { env: { GITHUB_REPOSITORY: 'owner/repo' } } });
  const action = new SourceTextModule(source, {
    context,
    initializeImportMeta: (meta) => {
      meta.dirname = '/action';
    }
  });
  await action.link((specifier) => {
    const exports = modules[specifier];
    assert.ok(exports, `Unexpected dependency: ${specifier}`);
    return new SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      },
      { context }
    );
  });
  await action.evaluate();
  await completed;
  return { deleted, zipped, unlinked, warnings, queries, failure, loggedError };
}

test('oldest cleanup deletes only the required artifact using its owning run', { timeout: 10000 }, async () => {
  const result = await runAction({}, { artifacts: [artifacts[2], artifacts[0], artifacts[1]] });
  assert.equal(result.failure, undefined);
  assert.deepEqual(result.deleted, [
    {
      name: 'artifact-1',
      token: 'test-token',
      workflowRunId: 101,
      repositoryName: 'repo',
      repositoryOwner: 'owner'
    }
  ]);
  assert.deepEqual(result.queries, [{ owner: 'owner', repo: 'repo', per_page: 100 }]);
});

test('newest cleanup deletes in reverse creation order and stops when enough space is free', async () => {
  const result = await runAction({ limit: '2MB', removeDirection: 'newest' });
  assert.equal(result.failure, undefined);
  assert.deepEqual(
    result.deleted.map(({ name }) => name),
    ['artifact-3', 'artifact-2']
  );
});

for (const limit of ['0KB', '-1']) {
  test(`limit ${limit} removes all artifacts without requiring reserved space`, async () => {
    const result = await runAction({ limit, fixedReservedSize: '' });
    assert.equal(result.failure, undefined);
    assert.equal(result.deleted.length, 3);
    assert.equal(result.zipped.length, 0);
  });
}

test('exactly sufficient space requires no deletion', async () => {
  const result = await runAction({ limit: '4MB' });
  assert.equal(result.failure, undefined);
  assert.deepEqual(result.deleted, []);
});

test('an empty repository requires no deletion', async () => {
  const result = await runAction({}, { artifacts: [] });
  assert.equal(result.failure, undefined);
  assert.deepEqual(result.deleted, []);
});

test('artifact paths reserve the total simulated ZIP size and ignore missing files', async () => {
  const result = await runAction(
    { fixedReservedSize: '', simulateCompressionLevel: '6' },
    {
      paths: ['file.txt', 'directory', 'missing.txt'],
      missingPaths: ['missing.txt']
    }
  );
  assert.equal(result.failure, undefined);
  assert.deepEqual(
    result.deleted.map(({ name }) => name),
    ['artifact-1', 'artifact-2']
  );
  assert.deepEqual(
    result.zipped.map(({ path, compression }) => ({ path, compression })),
    [
      { path: 'file.txt', compression: 6 },
      { path: 'directory', compression: 6 }
    ]
  );
  assert.equal(result.unlinked.length, 2);
  assert.equal(result.warnings.length, 1);
});

test('fixed reserved size takes precedence over artifact paths', async () => {
  const result = await runAction({}, { paths: ['file.txt'] });
  assert.equal(result.failure, undefined);
  assert.equal(result.deleted.length, 1);
  assert.deepEqual(result.zipped, []);
});

test('reserved space exceeding the limit fails before deleting anything', async () => {
  const result = await runAction({ fixedReservedSize: '4MB' });
  assert.match(result.failure, /exceeds the limit/);
  assert.deepEqual(result.deleted, []);
});

for (const [inputs, options, message] of [
  [{ token: '' }, {}, /Missing Github access token/],
  [{ removeDirection: 'invalid' }, {}, /Invalid removeDirection/],
  [{ simulateCompressionLevel: '10' }, { paths: ['file.txt'] }, /Invalid uploadCompressionLevel/]
]) {
  test(`invalid inputs fail without deleting artifacts: ${JSON.stringify(inputs)}`, async () => {
    const result = await runAction(inputs, options);
    assert.match(result.failure, message);
    assert.deepEqual(result.deleted, []);
  });
}

test('deletion errors fail the action by default', async () => {
  const result = await runAction({}, { deleteError: true });
  assert.equal(result.failure, 'Deletion failed');
  assert.equal(result.deleted.length, 1);
});

test('failOnError=false logs errors without failing the action', async () => {
  const result = await runAction({ failOnError: 'false' }, { deleteError: true });
  assert.equal(result.failure, undefined);
  assert.equal(result.loggedError, 'Deletion failed');
});

test('expired artifacts produce a warning and cleanup continues', async () => {
  const result = await runAction({}, { notFound: 'artifact-1' });
  assert.equal(result.failure, undefined);
  assert.deepEqual(
    result.deleted.map(({ name }) => name),
    ['artifact-1', 'artifact-2']
  );
  assert.equal(result.warnings.length, 1);
});

test('failed ZIP simulations still remove temporary files and do not delete artifacts', async () => {
  const result = await runAction({ fixedReservedSize: '' }, { paths: ['file.txt'], zipError: true });
  assert.equal(result.failure, 'ZIP failed');
  assert.equal(result.unlinked.length, 1);
  assert.deepEqual(result.deleted, []);
});
