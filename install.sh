#!/bin/bash
# Install extensions to pi

DEST="$HOME/.pi/agent/extensions"
mkdir -p "$DEST"
cp --remove-destination extensions/*.ts "$DEST/"
echo "Installed extensions to $DEST"
