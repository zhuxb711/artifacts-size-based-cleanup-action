import { Utils } from './utils';
import { Artifact, DefaultArtifactClient } from '@actions/artifact';
import bytes from 'bytes';
import PrettyError from 'pretty-error';
import _ from 'lodash';
import * as core from '@actions/core';
import * as github from '@actions/github';

const main = async () => {
  const token = core.getInput('token');
  const limit = bytes.parse(core.getInput('limit'));
  const requestSize = core.getInput('requestSize');
  const removeDirection = core.getInput('removeDirection');
  const uploadPaths = Utils.parseMultiLineInputs(core.getInput('uploadPaths'));
  const [ownerName, repoName] = process.env.GITHUB_REPOSITORY.split('/').map((part) => part.trim());

  if (limit < 0) {
    throw new Error('Invalid limit, must be a positive number');
  }

  if (_.isEmpty(token)) {
    throw new Error('Missing Github access token');
  }

  if (_.isEmpty(requestSize) && _.isEmpty(uploadPaths)) {
    throw new Error('Either requestSize or uploadPaths must be provided');
  }

  if (!_.includes(['newest', 'oldest'], removeDirection)) {
    throw new Error(`Invalid removeDirection, must be either 'newest' or 'oldest'`);
  }

  const validPaths = await Promise.all(
    uploadPaths.map((path) => Utils.checkPathExists(path).then((result) => (result ? path : undefined)))
  ).then((paths) => paths.filter((path) => !_.isEmpty(path)));

  _.differenceWith(uploadPaths, validPaths, (a, b) => a.localeCompare(b) == 0).forEach((path) =>
    core.warning(`Path does not exists and will be ignored: '${path}'`)
  );

  const retry = (await import('@octokit/plugin-retry')).retry;
  const throttling = (await import('@octokit/plugin-throttling')).throttling;
  const config_retries_enable = process.env.CLEANUP_OPTION_ENABLE_OCTOKIT_RETRIES;
  const config_max_allowed_retries = process.env.CLEANUP_OPTION_MAX_ALLOWED_RETRIES;
  const enableOctokitRetries = _.isEmpty(config_retries_enable) || config_retries_enable === 'true';
  const maxAllowedRetries = _.isEmpty(config_max_allowed_retries) ? 5 : Number(config_max_allowed_retries);

  core.info(
    `Start getting octokit client with retries ${
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
        onRateLimit: (retryAfter, options) => {
          core.warning(
            `Request quota exhausted for request ${options.method} ${options.url}, number of total global retries: ${options.request.retryCount}`
          );

          core.warning(`Retrying after ${retryAfter} seconds`);

          return enableOctokitRetries;
        },
        onSecondaryRateLimit: (retryAfter, options) => {
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

  core.info(`Querying all workflow runs for repository: '${ownerName}/${repoName}'`);

  const listWorkflowRunsResponse = await octokit.paginate(
    octokit.rest.actions.listWorkflowRunsForRepo.endpoint.merge({ owner: ownerName, repo: repoName, per_page: 50 }),
    ({ data }) =>
      data.map((run: any) => ({
        runId: run.id as number,
        workflowId: run.workflow_id as number,
        status: run.status as string,
        conclusion: run.conclusion as string
      }))
  );

  core.info(`Found ${listWorkflowRunsResponse.length} workflow runs`);

  Object.entries(_.groupBy(listWorkflowRunsResponse, (run) => run.workflowId)).forEach(([workflowId, runs]) => {
    core.info(`Workflow ${workflowId} has ${runs.length} runs: [${runs.map((run) => run.runId).join(', ')}]`);
  });

  const client = new DefaultArtifactClient();
  const artifacts = new Array<Artifact & { runId: number }>();

  for (const workflowRun of listWorkflowRunsResponse) {
    const listArtifactsResponse = await client.listArtifacts({
      findBy: {
        token: token,
        workflowRunId: workflowRun.runId,
        repositoryName: repoName,
        repositoryOwner: ownerName
      }
    });

    core.info(`Found ${listArtifactsResponse.artifacts.length} artifacts for workflow run ${workflowRun.runId}`);

    for (const artifact of listArtifactsResponse.artifacts) {
      artifacts.push({
        ...artifact,
        runId: workflowRun.runId
      });
    }
  }

  core.info(`Found ${artifacts.length} existing artifacts in total`);
  core.info(`Listing all artifacts: ${artifacts.map((artifact) => `'${artifact.name}'`).join(', ')}`);

  const totalSize = _.isEmpty(requestSize) ? await Utils.calcuateMultiPathSize(validPaths) : bytes.parse(requestSize);
  const artifactsTotalSize = artifacts.reduce((acc, artifact) => acc + artifact.size, 0);

  if (totalSize < 0) {
    throw new Error('Invalid requestSize, must be a positive number');
  }

  if (totalSize > limit) {
    throw new Error(`Total size of artifacts to upload exceeds the limit: ${bytes.format(totalSize)}`);
  }

  core.info(`Total size of artifacts to upload: ${bytes.format(totalSize)}`);
  core.info(`Total size of current artifacts: ${bytes.format(artifactsTotalSize)}`);

  if (totalSize + artifactsTotalSize > limit) {
    const freeSpaceNeeded = totalSize + artifactsTotalSize - limit;
    const sortedByDateArtifacts = artifacts.sort((a, b) =>
      removeDirection === 'oldest'
        ? (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0)
        : (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
    );

    core.info(`Preparing to delete artifacts, require minimum space: ${bytes.format(freeSpaceNeeded)}`);

    const deletedArtifacts = new Array<{ name: string; runId: number; size: number }>();

    for (let index = 0, deletedSize = 0; index < sortedByDateArtifacts.length; index++) {
      const { name, size, runId } = sortedByDateArtifacts[index];

      if (!_.isEmpty(name)) {
        deletedArtifacts.push({
          name: name,
          size: size,
          runId: runId
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
        Object.entries(_.groupBy(deletedArtifacts, (artifact) => artifact.runId)).forEach(([runId, artifact]) => {
          core.info(
            `Deleted ${artifact.length} artifacts: [${artifact
              .map((art) => `'${art.name}'`)
              .join(', ')}] from workflow runId ${runId} to free up space: ${bytes.format(
              artifact.reduce((acc, a) => acc + a.size, 0)
            )}`
          );
        });

        core.info(`${deletedArtifacts.length} artifacts deleted during the cleanup`);
        core.info(`Available space: ${bytes.format(limit - artifactsTotalSize + deletedSize)}`);

        break;
      }
    }
  }

  core.info(`Artifacts cleanup action completed`);
};

try {
  main();
} catch (err) {
  const pe = new PrettyError();

  if (core.getBooleanInput('failOnError')) {
    core.setFailed(pe.render(err));
  } else {
    core.error(pe.render(err));
  }
}
