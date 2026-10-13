import { stat, unlink } from 'node:fs/promises';
import artifact, { ArtifactNotFoundError } from '@actions/artifact';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import bytes from 'bytes';
import _ from 'lodash';
import PrettyError from 'pretty-error';
import { v4 as uuidv4 } from 'uuid';
import { Artifact } from './types';
import { Utils } from './utils';

const main = async () => {
  const token = core.getInput('token');

  const limit = bytes.parse(core.getInput('limit'));
  const removeDirection = core.getInput('removeDirection');
  const fixedReservedSize = bytes.parse(core.getInput('fixedReservedSize'));
  const simulateCompressionLevel = Number(core.getInput('simulateCompressionLevel'));
  const artifactPaths = core.getMultilineInput('artifactPaths');
  const [ownerName, repoName] = process.env.GITHUB_REPOSITORY.split('/').map((part) => part.trim());

  if (_.isEmpty(token)) {
    throw new Error('Missing Github access token. Please provide a token input or ensure GITHUB_TOKEN is available.');
  }

  if (limit > 0) {
    if (_.isEmpty(artifactPaths) && (Number.isNaN(fixedReservedSize) || fixedReservedSize < 0)) {
      throw new Error('Either fixedReservedSize or artifactPaths must be provided');
    }
  }

  if (!_.includes(['newest', 'oldest'], removeDirection)) {
    throw new Error(`Invalid removeDirection, must be either 'newest' or 'oldest'`);
  }

  if (!_.isEmpty(artifactPaths)) {
    if (Number.isNaN(simulateCompressionLevel) || simulateCompressionLevel < 0 || simulateCompressionLevel > 9) {
      throw new Error(`Invalid uploadCompressionLevel, must be a number between 0 and 9`);
    }
  }

  const config_retries_enable = process.env.CLEANUP_OPTION_ENABLE_OCTOKIT_RETRIES;
  const config_max_allowed_retries = process.env.CLEANUP_OPTION_MAX_ALLOWED_RETRIES;
  const enableOctokitRetries = _.isEmpty(config_retries_enable) || config_retries_enable === 'true';
  const maxAllowedRetries = _.isEmpty(config_max_allowed_retries) ? 5 : Number(config_max_allowed_retries);

  core.info(
    `Start creating octokit client with retries ${
      enableOctokitRetries ? 'enabled' : 'disabled'
    }, max allowed retries: ${maxAllowedRetries}`
  );

  const octokit = github.getOctokit(
    token,
    {
      request: {
        retries: maxAllowedRetries
      },
      throttle: {
        onRateLimit: (retryAfter: any, options: any) => {
          core.warning(
            `Request quota exhausted for request ${options.method} ${options.url}, number of total global retries: ${options.request.retryCount}`
          );

          core.warning(`Retrying after ${retryAfter} seconds`);

          return enableOctokitRetries;
        },
        onSecondaryRateLimit: (retryAfter: any, options: any) => {
          core.warning(
            `Request quota exhausted for request ${options.method} ${options.url}, number of total global retries: ${options.request.retryCount}`
          );

          core.warning(`Retrying after ${retryAfter} seconds`);

          return enableOctokitRetries;
        }
      }
    },
    retry,
    throttling
  );

  core.info(`Querying all artifacts for repository: '${ownerName}/${repoName}'`);

  const config_paginate_size = process.env.CLEANUP_OPTION_PAGINATE_SIZE;
  const apiCallPagniateSize = _.isEmpty(config_paginate_size) ? 100 : Number(config_paginate_size);

  const artifacts: Artifact[] = await octokit.paginate(
    octokit.rest.actions.listArtifactsForRepo.endpoint.merge({
      owner: ownerName,
      repo: repoName,
      per_page: apiCallPagniateSize
    }),
    ({ data }) =>
      (data as any[]).map<Artifact>((artifact: any) => ({
        id: artifact.id,
        name: artifact.name,
        size: artifact.size_in_bytes,
        runId: artifact.workflow_run.id,
        createdAt: new Date(artifact.created_at)
      }))
  );

  core.info(
    `Found ${artifacts.length} existing artifacts in total. Listing all artifacts: ${artifacts
      .map(
        (artifact) =>
          `'Artifact Id: ${artifact.id} | Artifact Name: ${artifact.name.replaceAll(/\s+/g, '.')} | Artifact Size: ${bytes.format(artifact.size)}'`
      )
      .join(', ')}`
  );

  const deletedArtifacts = new Array<Artifact>();

  if (limit > 0) {
    const retrievePendingSize = async () => {
      if (fixedReservedSize > 0) {
        return fixedReservedSize;
      }

      const validPaths = new Array<string>();
      const simulateAndGetCompressedSize = async (path: string, compressionLevel: number) => {
        const zipPath = import.meta.dirname + `/size_simulate_${uuidv4()}.zip`;

        try {
          return await stat(await Utils.createZipFile(path, zipPath, compressionLevel)).then((stats) => stats.size);
        } finally {
          await unlink(zipPath).catch(() => {
            core.warning(`Failed to delete simulated zip file: '${zipPath}'`);
          });
        }
      };

      for (const path of await Utils.expandPaths(artifactPaths)) {
        core.info(`Checking artifact path existence: '${path}'`);

        if (await Utils.checkPathExists(path)) {
          validPaths.push(path);
          continue;
        }

        core.warning(`Path does not exists and will be ignored: '${path}'`);
      }

      return _.sum(
        await Promise.all(validPaths.map((path) => simulateAndGetCompressedSize(path, simulateCompressionLevel)))
      );
    };

    const pendingSize = await retrievePendingSize();
    const existingArtifactsTotalSize = _.sumBy(artifacts, (artifact) => artifact.size);

    if (pendingSize > limit) {
      throw new Error(`Total size of artifacts to upload exceeds the limit: ${bytes.format(pendingSize)}`);
    }

    core.info(`Total size that need to be reserved: ${bytes.format(pendingSize)}`);
    core.info(`Total size of all existing artifacts: ${bytes.format(existingArtifactsTotalSize)}`);

    const freeSpaceNeeded = pendingSize + existingArtifactsTotalSize - limit;

    if (freeSpaceNeeded <= 0) {
      core.info(`No cleanup required, available space: ${bytes.format(limit - existingArtifactsTotalSize)}`);
      return;
    }

    core.info(`Preparing to delete artifacts, require minimum space: ${bytes.format(freeSpaceNeeded)}`);

    const sortedByDateArtifacts = artifacts.sort((a, b) =>
      removeDirection === 'oldest'
        ? (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0)
        : (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
    );

    for (let index = 0, deletedSize = 0; index < sortedByDateArtifacts.length; index++) {
      const art = sortedByDateArtifacts[index];

      if (!_.isEmpty(art.name)) {
        deletedArtifacts.push({
          id: art.id,
          name: art.name,
          size: art.size,
          runId: art.runId,
          createdAt: art.createdAt
        });

        try {
          await artifact.deleteArtifact(art.name, {
            findBy: {
              token: token,
              workflowRunId: art.runId,
              repositoryName: repoName,
              repositoryOwner: ownerName
            }
          });
        } catch (error) {
          if (error instanceof ArtifactNotFoundError) {
            core.warning(
              `Failed to delete artifact '${art.name}' within RunId '${art.runId}' because artifact is not found and maybe expired.`
            );
            continue;
          }

          throw error;
        }
      }

      if ((deletedSize += art.size) >= freeSpaceNeeded) {
        core.info(
          `Summary: available space after cleanup: ${bytes.format(limit - existingArtifactsTotalSize + deletedSize)}`
        );
        break;
      }
    }
  } else {
    core.info(`Limit is less or equal to 0, start cleanup all existing artifacts`);

    for (const art of artifacts) {
      if (!_.isEmpty(art.name)) {
        deletedArtifacts.push({
          id: art.id,
          name: art.name,
          size: art.size,
          runId: art.runId,
          createdAt: art.createdAt
        });

        try {
          await artifact.deleteArtifact(art.name, {
            findBy: {
              token: token,
              workflowRunId: art.runId,
              repositoryName: repoName,
              repositoryOwner: ownerName
            }
          });
        } catch (error) {
          if (error instanceof ArtifactNotFoundError) {
            core.warning(
              `Failed to delete artifact '${art.name}' within RunId '${art.runId}' because artifact is not found and maybe expired.`
            );
            continue;
          }

          throw error;
        }
      }
    }
  }

  core.info(
    `Summary: free up space after cleanup: ${bytes.format(_.sumBy(deletedArtifacts, (artifact) => artifact.size))}`
  );

  Object.entries(_.groupBy(deletedArtifacts, (artifact) => artifact.runId)).forEach(([runId, artifact]) => {
    core.info(
      `Summary: ${artifact.length} artifacts deleted from workflow run 'RunId_${runId}': [${artifact
        .map(
          (art) =>
            `'Artifact Id: ${art.id} | Artifact Name: ${art.name.replaceAll(/\s+/g, '.')}' | Artifact Size: ${bytes.format(art.size)}`
        )
        .join(', ')}]`
    );
  });
};

main()
  .then(() => core.info(`Artifacts cleanup action completed successfully`))
  .catch((err) => {
    const pe = new PrettyError();

    if (core.getBooleanInput('failOnError')) {
      core.setFailed(pe.render(err));
    } else {
      core.error(pe.render(err));
    }
  });
