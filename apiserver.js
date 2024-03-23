import { extensions } from './config.js';
import { gitVersion } from './gitversion.js';
import { config } from 'dotenv';
const globalConfig=config().parsed;


import express, { json, urlencoded } from "express";

import pkg from 'body-parser';
const { json: _json } = pkg;


const port = globalConfig.PORT || 8667;
const app = express();


app.use(json());
app.use(urlencoded({ extended: true }));
app.use(_json());


app.use((req, res, next) => 
  {
    res.header("Access-Control-Allow-Origin", (req.headers.referer!= undefined ? req.headers.referer.replace(/\/+$/, '') : 'http://127.0.0.1:8044')); 
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Credentials", "true");
    next();
  });

 extensions.forEach((e)=> 
 {
  e.extension.register(app,e.prefix);
  app.use('/'+e.prefix,express.static(e.publicpath)); 
  console.log('Registering extension "'+e.extension.name+'" with slug "'+e.extension.slug+'" with prefix "'+e.prefix+'" and public path "'+e.publicpath+'"');
 });
 

app.get("/", (req, res) => 
{
    return res.redirect("index.html");
});



// Starting the server on the 80 port
app.listen(port, () => 
{
	console.log(`The application version ${gitVersion} started successfully on port ${port}`);
});
