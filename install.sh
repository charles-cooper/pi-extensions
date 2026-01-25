#!/bin/bash
# Install subagent extension to pi

DEST="$HOME/.pi/agent/extensions"
mkdir -p "$DEST"
cp subagent.ts "$DEST/"
echo "Installed subagent.ts to $DEST"
