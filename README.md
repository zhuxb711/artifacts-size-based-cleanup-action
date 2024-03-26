![CI](https://img.shields.io/github/actions/workflow/status/zhuxb711/artifacts-size-based-cleanup-action/ci.yml)

# Artifacts Size-based Cleanup Action

Cleanup artifacts base on the size limit to make sure the storage space is not exhausted.

This action helps you cleanup the oldest/newest artifacts when space is not enough for the pending upload artifacts.

| limit | requestSize / calcalated size | removeDirection | Total size of existing artifacts                         | Behavior                                      |
| ----- | ----------------------------- | --------------- | -------------------------------------------------------- | --------------------------------------------- |
| 10MB  | 5MB                           | oldest          | 6MB --> Artifact 1 (Older): 2MB, Artifact 2 (Newer): 4MB | Artifact 1 will be deleted                    |
| 10MB  | 5MB                           | newest          | 6MB --> Artifact 1 (Older): 2MB, Artifact 2 (Newer): 4MB | Artifact 2 will be deleted                    |
| 10MB  | 5MB                           | oldest          | 5MB --> Artifact 1 (Older): 2MB, Artifact 2 (Newer): 3MB | None (Space is enough to place new artifacts) |
| 10MB  | 5MB                           | oldest          | 4MB --> Artifact 1 (Older): 2MB, Artifact 2 (Newer): 2MB | None (Space is enough to place new artifacts) |
| 10MB  | 5MB                           | oldest / newest | 9MB --> Artifact 1 (Older): 3MB, Artifact 2 (Newer): 6MB | Artifact 1 & Artifact 2 will be deleted       |
| 10MB  | 12MB                          | oldest / newest | <Any>                                                    | Exception throw                               |

#### **_Make sure you run this cleanup action before upload the artifacts_**

## Usage

See also [action.yml](https://github.com/zhuxb711/artifacts-size-based-cleanup-action/blob/main/action.yml)

### Simple example

```yml
- name: Run cleanup action
  uses: zhuxb711/artifacts-size-based-cleanup-action@v1
  with:
    token: '<Your Github token>'
    limit: 1GB
    uploadPaths: <Your path to the files or directories that pending uploads>
```

### Specify multiple uploadPaths

```yml
- name: Run cleanup action
  uses: zhuxb711/artifacts-size-based-cleanup-action@v1
  with:
    token: '<Your Github token>'
    limit: 1GB
    uploadPaths: |
      <Path 1>
      <Path 2>
      <Path 3>
```

### Specify a fixed size that need to be reserved

```yml
- name: Run cleanup action
  uses: zhuxb711/artifacts-size-based-cleanup-action@v1
  with:
    token: '<Your Github token>'
    limit: 1GB
    requestSize: 512MB
```

### Complete example

```yml
- name: Run cleanup action
  uses: zhuxb711/artifacts-size-based-cleanup-action@v1
  with:
    token: '<Your Github token>' # Token must be granted access permission with 'workflow' scope
    limit: 1GB # Could also set to 1024MB/512KB/2.5GB or size in bytes
    requestSize: 512MB # Optional. Fixed size you want to reserved for the new artifacts. Must set 'uploadPaths' or 'requestSize'.
    failOnError: true # Optional. Reports failure if meet any exception
    removeDirection: oldest # Optional. Remove the oldest artifact first or the newest one first
    uploadPaths: <Your path to the files that pending uploads> # Optional. Must set 'uploadPaths' or 'requestSize'.
```
