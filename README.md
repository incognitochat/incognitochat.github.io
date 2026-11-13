# incognitochat.github.io

Hosting only. The app's code lives in [incognitochat/incognitochat](https://github.com/incognitochat/incognitochat).

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) is the only way
this site is published: it builds a release tag of the code repository,
writes `manifest.json`, attests every file with Sigstore, and deploys with
GitHub Pages' own action. Its reviewed copy is
[`hosting/deploy.yml`](https://github.com/incognitochat/incognitochat/blob/main/hosting/deploy.yml)
in the code repository, which also explains how to
[check the live site](https://github.com/incognitochat/incognitochat/blob/main/docs/verifying.md).
