import { Utils } from './utils';
import { DefaultArtifactClient } from '@actions/artifact';
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

  const octokit = github.getOctokit(token);
  const test = await octokit.paginate(
    octokit.rest.actions.listWorkflowRunsForRepo.endpoint.merge({ owner: ownerName, repo: repoName, per_page: 50 }),
    ({ data }) => data
  );

  core.info(JSON.stringify(test));

  const client = new DefaultArtifactClient();
  const listArtifactsResponse = await client.listArtifacts();

  core.info(`Found ${listArtifactsResponse.artifacts.length} existing artifacts`);
  core.info(`Artifacts: ${listArtifactsResponse.artifacts.map((artifact) => `'${artifact.name}'`).join(', ')}`);

  const validPaths = await Promise.all(uploadPaths.map((path) => Utils.checkPathExists(path).then(() => path)));

  _.differenceWith(uploadPaths, validPaths, (a, b) => a.localeCompare(b) == 0).forEach((path) =>
    core.warning(`Path does not exists: ${path}`)
  );

  const totalSize = _.isEmpty(requestSize) ? await Utils.calcuateMultiPathSize(validPaths) : bytes.parse(requestSize);
  const artifactsTotalSize = listArtifactsResponse.artifacts.reduce((acc, artifact) => acc + artifact.size, 0);

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
    const sortedByDateArtifacts = listArtifactsResponse.artifacts.sort((a, b) =>
      removeDirection === 'oldest'
        ? (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0)
        : (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
    );

    core.info(`Preparing to delete artifacts, require minimum space: ${bytes.format(freeSpaceNeeded)}`);

    for (let index = 0, deletedSize = 0; index < sortedByDateArtifacts.length; index++) {
      const { name, size } = sortedByDateArtifacts[index];

      if (!_.isEmpty(name)) {
        await client.deleteArtifact(name);
      }

      if ((deletedSize += size) >= freeSpaceNeeded) {
        core.info(`Deleted ${index + 1} artifacts to free up space: ${bytes.format(deletedSize)}`);
        core.info(`Available space: ${bytes.format(limit - artifactsTotalSize + deletedSize)}`);
        break;
      }
    }
  }

  core.info(`Artifacts cleanup completed`);
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
