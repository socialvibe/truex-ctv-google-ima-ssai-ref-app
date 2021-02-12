#!/usr/bin/env node

require('promisify').polyfill();

const logger = require('logger');
const s3 = require('s3-upload');
const uploadDist = require('promise-to-upload-dist');
const awsCloudFrontInvalidate = require("invalidate-cloudfront-edge-cache");

const deploy = () => {
    const log = logger.create('deploy');

    const bucket = "ctv.truex.com";
    //const branch = process.env.TRAVIS_BRANCH;
    const branch = 'develop';
    const prefix = 'web/ref-app-google-IMA/' + branch;

    const isPR = process.env.TRAVIS_PULL_REQUEST == "true";
    log(`travis: PR: ${prefix} branch: ${process.env.TRAVIS_BRANCH}`);
    if (isPR) {
        // We only want to deploy on the final merges.
        log(`PR deploy skipped for ${bucket}/${prefix}`);
        process.exit(0);
    }

    log(`deploying to ${bucket}/${prefix}`);
    return s3.cleanFolder(bucket, prefix)
        .then(() => {
            return uploadDist(bucket, prefix);
        })
        .then(() => {
            log("invalidating cloudfront cache");
            const distributionId = process.env.TRUEX_CLOUDFRONT_DISTRIBUTION_ID;
            const pathsToInvalidate = [`/${prefix}/index.html`];
            return awsCloudFrontInvalidate(distributionId, pathsToInvalidate);
        })
        .then(() => {
            log("deploy complete");
        })
        .catch((err) => {
            console.error(`deploy error: ${err}`);
            process.exit(1);
        });
};

deploy();