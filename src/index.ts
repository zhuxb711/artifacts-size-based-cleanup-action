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

  core.info(`Querying all workflow runs for repository: '${ownerName}/${repoName}'`);

  const allWorkflowRuns = await octokit.paginate(
    octokit.rest.actions.listWorkflowRunsForRepo.endpoint.merge({ owner: ownerName, repo: repoName, per_page: 50 }),
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
    core.info(
      `Workflow '${runs.find((run) => run.workflowId === Number(workflowId))?.workflowName}' has ${
        runs.length
      } runs: ['${runs.map((run) => `RunId_${run.runId}-RunName_${run.runName.replaceAll(/\s+/g, '.')}`).join(', ')}']`
    );
  });

  const client = new DefaultArtifactClient();
  const artifacts = new Array<Artifact & { runId: number; workflowId: number }>();

  for (const run of allWorkflowRuns) {
    const allArtifactsInRun = await client.listArtifacts({
      findBy: {
        token: token,
        workflowRunId: run.runId,
        repositoryName: repoName,
        repositoryOwner: ownerName
      }
    });

    core.info(
      `Found ${allArtifactsInRun.artifacts.length} artifacts for workflow run: 'RunId_${
        run.runId
      }-RunName_${run.runName.replaceAll(/\s+/g, '.')}'`
    );

    allArtifactsInRun.artifacts.forEach((artifact) => {
      artifacts.push({
        ...artifact,
        runId: run.runId,
        workflowId: run.workflowId
      });
    });
  }

  core.info(
    `Found ${artifacts.length} existing artifacts in total. Listing all artifacts: ${artifacts
      .map(
        (artifact) =>
          `'WorkflowId_${artifact.workflowId}-RunId_${artifact.runId}-ArtifactId_${
            artifact.id
          }-ArtifactName_${artifact.name.replaceAll(/\s+/g, '.')}'`
      )
      .join(', ')}`
  );

  const totalSize = _.isEmpty(requestSize) ? await Utils.calcuateMultiPathSize(validPaths) : bytes.parse(requestSize);
  const artifactsTotalSize = artifacts.reduce((acc, artifact) => acc + artifact.size, 0);

  if (totalSize < 0) {
    throw new Error('Invalid requestSize, must be a positive number');
  }

  if (totalSize > limit) {
    throw new Error(`Total size of artifacts to upload exceeds the limit: ${bytes.format(totalSize)}`);
  }

  core.info(`Total size that need to be reserved: ${bytes.format(totalSize)}`);
  core.info(`Total size of all existing artifacts: ${bytes.format(artifactsTotalSize)}`);

  if (totalSize + artifactsTotalSize > limit) {
    const freeSpaceNeeded = totalSize + artifactsTotalSize - limit;
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
        core.info(`Summary: available space after cleanup: ${bytes.format(limit - artifactsTotalSize + deletedSize)}`);
        break;
      }
    }

    core.info(
      `Summary: free up space after cleanup: ${bytes.format(deletedArtifacts.reduce((acc, a) => acc + a.size, 0))}`
    );

    Object.entries(_.groupBy(deletedArtifacts, (artifact) => artifact.runId)).forEach(([runId, artifact]) => {
      core.info(
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
