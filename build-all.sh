#!/bin/sh

set -eu

#------------------------------------------------------

git clean -xfd
npm install

VERSION=`npx screw-up dump | jq -r '.version'`

echo "Build totally deployments: $VERSION"

#------------------------------------------------------

npm run test
npm run pack

#------------------------------------------------------

./build-docker-multiplatform.sh --skip-app-build

#------------------------------------------------------

#npm publish ./artifacts/npmjs-server-$VERSION.tgz
#podman manifest push npmjs-server:$VERSION docker://docker.io/kekyo/npmjs-server:$VERSION
#podman manifest push npmjs-server:latest docker://docker.io/kekyo/npmjs-server:latest
