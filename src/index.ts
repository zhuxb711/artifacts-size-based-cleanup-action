import { Utils } from './utils';
import { v4 as uuidv4 } from 'uuid';
import { Artifact, DefaultArtifactClient, ListArtifactsResponse } from '@actions/artifact';
import bytes from 'bytes';
import PrettyError from 'pretty-error';
import _ from 'lodash';
import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fsPromise from 'fs/promises';

const main = async () => {
  const token = core.getInput('token');
  const limit = bytes.parse(core.getInput('limit'));
  const removeDirection = core.getInput('removeDirection');
  const fixedReservedSize = bytes.parse(core.getInput('fixedReservedSize'));
  const simulateCompressionLevel = Number(core.getInput('simulateCompressionLevel'));
  const artifactPaths = core.getMultilineInput('artifactPaths');
  const [ownerName, repoName] = process.env.GITHUB_REPOSITORY.split('/').map((part) => part.trim());

  if (Number.isNaN(limit) || limit < 0) {
    throw new Error('Invalid limit, must be a positive number');
  }

  if (_.isEmpty(token)) {
    throw new Error('Missing Github access token');
  }

  if (_.isEmpty(artifactPaths) && (Number.isNaN(fixedReservedSize) || fixedReservedSize <= 0)) {
    throw new Error('Either fixedReservedSize or artifactPaths must be provided');
  }

  if (!_.includes(['newest', 'oldest'], removeDirection)) {
    throw new Error(`Invalid removeDirection, must be either 'newest' or 'oldest'`);
  }

  if (Number.isNaN(simulateCompressionLevel) || simulateCompressionLevel < 0 || simulateCompressionLevel > 9) {
    throw new Error(`Invalid uploadCompressionLevel, must be a number between 0 and 9`);
  }

  const validPaths = await Promise.all(
    artifactPaths.map((path) => Utils.checkPathExists(path).then((result) => (result ? path : undefined)))
  ).then((paths) => paths.filter((path) => !_.isEmpty(path)));

  _.differenceWith(artifactPaths, validPaths, (a, b) => a.localeCompare(b) == 0).forEach((path) =>
    core.warning(`Path does not exists and will be ignored: '${path}'`)
  );

  const retry = (await import('@octokit/plugin-retry')).retry;
  const throttling = (await import('@octokit/plugin-throttling')).throttling;
  const config_retries_enable = process.env.CLEANUP_OPTION_ENABLE_OCTOKIT_RETRIES;
  const config_max_allowed_retries = process.env.CLEANUP_OPTION_MAX_ALLOWED_RETRIES;
  const enableOctokitRetries = _.isEmpty(config_retries_enable) || config_retries_enable === 'true';
  const maxAllowedRetries = _.isEmpty(config_max_allowed_retries) ? 5 : Number(config_max_allowed_retries);

  core.debug(
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
        },
        onAbuseLimit: (retryAfter, options) => {
          core.warning(
            `Abuse detected for request ${options.method} ${options.url}, retry count: ${options.request.retryCount}`
          );

          core.warning(`Retrying after ${retryAfter} seconds`);

          return enableOctokitRetries;
        }
      }
    },
    retry,
    throttling
  );

  core.debug(`Querying all workflow runs for repository: '${ownerName}/${repoName}'`);

  const config_paginate_size = process.env.CLEANUP_OPTION_PAGINATE_SIZE;
  const apiCallPagniateSize = _.isEmpty(config_paginate_size) ? 50 : Number(config_paginate_size);

  const allWorkflowRuns = await octokit.paginate(
    octokit.rest.actions.listWorkflowRunsForRepo.endpoint.merge({
      owner: ownerName,
      repo: repoName,
      per_page: apiCallPagniateSize
    }),
    ({ data }) =>
      data.map((run: any) => ({
        runId: run.id as number,
        runName: run.display_title as string,
        workflowId: run.workflow_id as number,
        workflowName: run.name as string,
        status: run.status as string,
        conclusion: run.conclusion as string
      }))
  );

  Object.entries(_.groupBy(allWorkflowRuns, (run) => run.workflowId)).forEach(([workflowId, runs]) => {
    core.debug(
      `Workflow '${runs.find((run) => run.workflowId === Number(workflowId))?.workflowName}' has ${
        runs.length
      } runs: ['${runs.map((run) => `RunId_${run.runId}-RunName_${run.runName.replaceAll(/\s+/g, '.')}`).join(', ')}']`
    );
  });

  const client = new DefaultArtifactClient();
  const artifacts = new Array<Artifact & { runId: number; workflowId: number }>();

  for (const workflowRun of allWorkflowRuns) {
    const allArtifactsInRun = await client
      .listArtifacts({
        findBy: {
          token: token,
          workflowRunId: workflowRun.runId,
          repositoryName: repoName,
          repositoryOwner: ownerName
        }
      })
      .catch<ListArtifactsResponse>((err) => {
        core.warning(
          `Failed to list artifacts for workflow run: 'RunId_${
            workflowRun.runId
          }-RunName_${workflowRun.runName.replaceAll(/\s+/g, '.')}', this run will be ignored, error: ${err.message}`
        );

        return undefined;
      });

    if (allArtifactsInRun) {
      core.debug(
        `Found ${allArtifactsInRun.artifacts.length} artifacts for workflow run: 'RunId_${
          workflowRun.runId
        }-RunName_${workflowRun.runName.replaceAll(/\s+/g, '.')}'`
      );

      allArtifactsInRun.artifacts.forEach((artifact) => {
        artifacts.push({
          ...artifact,
          runId: workflowRun.runId,
          workflowId: workflowRun.workflowId
        });
      });
    }
  }

  core.debug(
    `Found ${artifacts.length} existing artifacts in total. Listing all artifacts: ${artifacts
      .map(
        (artifact) =>
          `'WorkflowId_${artifact.workflowId}-RunId_${artifact.runId}-ArtifactId_${
            artifact.id
          }-ArtifactName_${artifact.name.replaceAll(/\s+/g, '.')}'`
      )
      .join(', ')}`
  );

  const simulateAndGetCompressedSize = async (path: string, compressionLevel: number) => {
    const zipPath = __dirname + `/size_simulate_${uuidv4()}.zip`;
    await Utils.createZipFile(path, zipPath, compressionLevel);
    return await fsPromise.stat(zipPath).then((stat) => stat.size);
  };

  const pendingArtifactsTotalSize =
    fixedReservedSize > 0
      ? fixedReservedSize
      : _.sum(
          await Promise.all(validPaths.map((path) => simulateAndGetCompressedSize(path, simulateCompressionLevel)))
        );
  const existingArtifactsTotalSize = _.sumBy(artifacts, (artifact) => artifact.size);

  if (pendingArtifactsTotalSize > limit) {
    throw new Error(`Total size of artifacts to upload exceeds the limit: ${bytes.format(pendingArtifactsTotalSize)}`);
  }

  core.info(`Total size that need to be reserved: ${bytes.format(pendingArtifactsTotalSize)}`);
  core.info(`Total size of all existing artifacts: ${bytes.format(existingArtifactsTotalSize)}`);

  if (pendingArtifactsTotalSize + existingArtifactsTotalSize > limit) {
    const freeSpaceNeeded = pendingArtifactsTotalSize + existingArtifactsTotalSize - limit;
    const sortedByDateArtifacts = artifacts.sort((a, b) =>
      removeDirection === 'oldest'
        ? (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0)
        : (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
    );

    core.info(`Preparing to delete artifacts, require minimum space: ${bytes.format(freeSpaceNeeded)}`);

    const deletedArtifacts = new Array<{
      id: number;
      name: string;
      size: number;
      runId: number;
      workflowId: number;
    }>();

    for (let index = 0, deletedSize = 0; index < sortedByDateArtifacts.length; index++) {
      const { name, size, id, runId, workflowId } = sortedByDateArtifacts[index];

      if (!_.isEmpty(name)) {
        deletedArtifacts.push({
          id: id,
          name: name,
          size: size,
          runId: runId,
          workflowId: workflowId
        });

        await client.deleteArtifact(name, {
          findBy: {
            token: token,
            workflowRunId: runId,
            repositoryName: repoName,
            repositoryOwner: ownerName
          }
        });
      }

      if ((deletedSize += size) >= freeSpaceNeeded) {
        core.info(
          `Summary: available space after cleanup: ${bytes.format(limit - existingArtifactsTotalSize + deletedSize)}`
        );
        break;
      }
    }

    core.info(
      `Summary: free up space after cleanup: ${bytes.format(_.sumBy(deletedArtifacts, (artifact) => artifact.size))}`
    );

    Object.entries(_.groupBy(deletedArtifacts, (artifact) => artifact.runId)).forEach(([runId, artifact]) => {
      core.debug(
        `Summary: ${artifact.length} artifacts deleted from workflow run 'RunId_${runId}-RunName_${allWorkflowRuns
          .find((run) => run.runId === Number(runId))
          ?.runName.replaceAll(/\s+/g, '.')}': [${artifact
          .map(
            (art) =>
              `'WorkflowId_${art.workflowId}-RunId_${art.runId}-ArtifactId_${art.id}-ArtifactName_${art.name.replaceAll(
                /\s+/g,
                '.'
              )}'`
          )
          .join(', ')}]`
      );
    });
  } else {
    core.info(`No cleanup required, available space: ${bytes.format(limit - existingArtifactsTotalSize)}`);
  }
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
