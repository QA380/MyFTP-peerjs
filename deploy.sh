#!/bin/bash

# Load environment variables if you have them locally
# export $(grep -v '^#' .env | xargs)

echo "Starting deployment process..."

if [[ "$1" == "--prod" ]] || [[ "$1" == "-p" ]]; then
    echo "Deploying to PRODUCTION..."
    # --yes skips the confirmation prompts
    # --prod triggers the production environment
    vercel --prod --yes
else
    echo "Deploying to PREVIEW..."
    vercel --yes
fi

if [ $? -eq 0 ]; then
    echo "Deployment successful!"
else
    echo "Deployment failed."
    exit 1
fi
