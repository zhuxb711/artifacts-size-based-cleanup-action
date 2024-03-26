import { DefaultArtifactClient } from '@actions/artifact';
import bytes from 'bytes';
import PrettyError from 'pretty-error';
import * as core from '@actions/core';
import _ from 'lodash';
import { Utils } from './utils';

const main = async () => {
  const limit = bytes.parse(core.getInput('limit'));
  const requestSize = core.getInput('requestSize');
  const removeDirection = core.getInput('removeDirection');
  const uploadPaths = Utils.parseMultiLineInputs(core.getInput('uploadPaths'));

  if (_.isEmpty(requestSize) && _.isEmpty(uploadPaths)) {
    throw new Error('Either requestSize or uploadPaths must be provided');
  }

  if (!_.includes(['newest', 'oldest'], removeDirection)) {
    throw new Error(`Invalid removeDirection, must be either 'newest' or 'oldest'`);
  }

  const client = new DefaultArtifactClient();
  const listArtifactsResponse = await client.listArtifacts();

  const totalSize = _.isEmpty(requestSize) ? await Utils.calcuateMultiPathSize(uploadPaths) : bytes.parse(requestSize);
  const artifactsTotalSize = listArtifactsResponse.artifacts.reduce((acc, artifact) => acc + artifact.size, 0);

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
        await client.deleteArtifact(name).then(() => core.info(`Deleted artifact: '${name}'`));
      }

      if ((deletedSize += size) >= freeSpaceNeeded) {
        core.info(`Deleted ${index + 1} artifacts to free up space: ${bytes.format(deletedSize)}`);
        break;
      }
    }
  }
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
