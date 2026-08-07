#!/bin/bash
cd "/root/trypost"
git fetch origin main
if [ $(git rev-parse HEAD) != $(git rev-parse @{u}) ]; then
  git pull origin main
  docker-compose -f compose.yaml up -d --build
fi
