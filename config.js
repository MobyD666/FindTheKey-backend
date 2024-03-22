import {FindTheKey } from './FindTheKey.js';

import { config } from 'dotenv';
const globalConfig=config().parsed;

const extensions = new Array();

extensions.push({extension:new FindTheKey (globalConfig),'prefix':'ftk/','publicpath':'public'});

export {extensions};