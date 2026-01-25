#!/bin/bash
# Install extensions to pi

DEST="$HOME/.pi/agent/extensions"
mkdir -p "$DEST"
cp extensions/*.ts "$DEST/"
echo "Installed extensions to $DEST"
