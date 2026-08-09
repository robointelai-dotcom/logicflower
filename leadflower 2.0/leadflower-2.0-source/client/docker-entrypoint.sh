#!/bin/sh
# Publish the built shell for the API to read.
#
# The API injects per-article metadata into this file so that a crawler which
# does not run JavaScript still reads the right title and description. Copied at
# start-up because a named Docker volume is empty until something writes to it.
set -e

if [ -d /usr/share/nginx/html-shared ]; then
  cp /usr/share/nginx/html/index.html /usr/share/nginx/html-shared/index.html
  echo "published client shell for the API"
fi
