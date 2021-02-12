"use strict";

const fs = require('fs');
const pkg = require('./package.json');

module.exports = function(env) {
    if (typeof env === "object") {
        // Can happen during webpack dev runs.
        env = env.env;
    }
    if (!env) env = 'dev';

    let configPath = './src/config.js';
    console.log(`generating ${env} build ${pkg.version}: ${configPath}`);

    let config = {
        name: pkg.name,
        version: pkg.version,
        buildDate: new Date().toISOString().replace('T', ' ').replace(/\..+$/, ''),
        buildEnv: env,
    };

    let content = `
// This file is auto generated from package.json
const c = ${JSON.stringify(config, null, 2)};

export const config = c;
export default config;\n`;
    fs.writeFileSync(configPath, content);

    return config;
};

