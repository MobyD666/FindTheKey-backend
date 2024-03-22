import { extensions } from './config.js';
import { config } from 'dotenv';
const globalConfig=config().parsed;

extensions.forEach( async  e => await e.extension.run(process.argv));
