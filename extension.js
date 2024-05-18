
import fetch from 'node-fetch';

import { config } from 'dotenv';
import path from 'path';
import fs from 'fs';

import crypto from 'crypto';

import {StatsSpooler,StatsCounter} from './StatsSpooler.js';
import {Cache,MemoryCache} from './cache.js';
import { Regular } from './regular.js';
import {Mutex} from 'async-mutex';

/**
 * Abstract base class for chaster.app extensions. This class provides basic methods for communicating with Chaster API and some utility methods.
 * expected usage is that you create a new class extending this base class and implement your logic. You then confgiture your extension in config.js.
 * There are three ways your class can be used. 
 * First is via runtime action on the server. Example is periodic maintiance of locked session. The run.js script will call call method run of each registered extensions. 
 * Second is via API call from your frontend. You need to implement main page and optionally confguration page
 * Third is via webHooks. It is not yet implemented on Chaster side
 */
class  Extension
{
    

    /**
     * constructor - set up the extension. Call this from your constructor
     */
    constructor()
    {     
       this.dead=false; //** dead==true means that the extension is not supposed to live but more for one shot kind of things */
       this.config=config().parsed; 

       this.mainTokenCache=new MemoryCache();
       this.basicInfoCache=new MemoryCache();
        
       this.debug = this.isTrue(this.config.DEBUG) || (this.config.NODE_ENV === 'development'); 
       this.debugAPICall = this.isTrue(this.config.DEBUGAPI) || (this.config.NODE_ENV === 'development'); 
       this.profileAPICall = this.isTrue(this.config.PROFILEAPI) || (this.config.NODE_ENV === 'development'); 
       this.debugWebHooks = this.isTrue(this.config.DEBUGWEBHOOKS) || (this.config.NODE_ENV === 'development'); 
       this.debugNew = this.isTrue(this.config.DEBUGNEW) || (this.config.NODE_ENV === 'development'); 
       this.debugMutex = this.isTrue(this.config.DEBUGMUTEX) || (this.config.NODE_ENV === 'development'); 
       this.chasterBaseUrl = this.config.CHASTERURL ||  'https://api.chaster.app/api/extensions/'
       this.statsFilename = this.config.STATSFILENAME ||  null;
       this.delayedEventsFilename = this.config.DELAYEDEVENTSFILENAME ||  null;
       if (this.config.DEAD != undefined) this.dead=this.isTrue(this.config.DEAD);
       this.name = 'abstractExtension';
       this.slug = '';
       this.webhooks = {};
       this.profiles={};
       this.mutexes={};

       this.delayedEvents=[];

       this.stats= new StatsSpooler(config);
       this.setupStats();

       if (this.statsFilename != null) 
       {
        this.stats.loadStats(this.statsFilename);
        setInterval(() => this.stats.saveStats(this.statsFilename), 60000); // Save every 60 seconds
       }

       if (this.delayedEventsFilename != null)
       {
         this.loadDelayedEvents();
         setInterval(async () => await this.processDelayedEvents(), 15000); // Process every 15 seconds
       }

       process.on('SIGINT', () => this.shutdown());
       process.on('SIGTERM', () => this.shutdown());

    }

    generateRandomIdentifier(length=8) 
    {
        const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let identifier = '';
        
        for (let i = 0; i < length; i++) 
        {
          const randomIndex = Math.floor(Math.random() * characters.length);
          identifier += characters.charAt(randomIndex);
        }
        
        return identifier;
      }

    isTrue(s)
    {
        return ((s===true) || ((typeof s == 'string') && ((s.toUpperCase()==="TRUE") || (s.toUpperCase==="ON"))));
    }

    setupStats()
    {
        this.stats.addStat(new StatsCounter('api_call','The total number of calls to the chaster API'));
        this.stats.addStat(new StatsCounter('api_exhausted','The total number of exhausted calls to the chaster API'));
        this.stats.addStat(new StatsCounter('cs_wait','The total number of critical section waits'));
    }

    start_profile(profile)
    {
        this.profiles[profile]=Date.now();
    }

    end_profile(profile)
    {
        return(Date.now()-this.profiles[profile]);
    }

    /**
     * Ensure named critical section. If the names CS is being used, wait until it has been released before returning.
     * @param {*} name name of the critical section
     * @param {null} [waitHandler=null]  optional handler that will be called when the critical section has  been waiting for more than few miliseconds.
     * @returns  release handler to release the critical section. Failure to call this function will result in blocked CS
     */
    async ensureCS(name, waitHandler=null)
    {
        if (this.debugMutex) console.log(name,'ensureCS entering');
        if (name == undefined) return ( () => {} );
        if (this.mutexes[name] == undefined) 
        {
            if (this.debugMutex) console.log(name,'creating mutex');
            this.mutexes[name]=new Mutex();
        }
        const profilename=name+'-'+this.generateRandomIdentifier(8);
        this.start_profile(profilename);
        const release = await this.mutexes[name].acquire();
        const cswait=this.end_profile(profilename);
        if (this.debugMutex) console.log(name,'ensureCS wait ms',cswait);
        if (cswait >100)
        {
            if (this.debugMutex) console.log(name,'critical section release wait ',cswait,'ms');
            this.stats.statsCounterInc('cs_wait','{time="'+((Math.floor(cswait/500)*500).toString().padStart(5,'0'))+'"}');
            if (waitHandler != null) await waitHandler();
        }
        else
        {
            this.stats.statsCounterInc('cs_wait','{time="nowait"}');
        }
        if (this.debugMutex) console.log(name,'ensureCS leaving');
        return (release);
    }

    /**
     * Release the named critical section. Use this as an alternative to calling the function returned by ensureCS
     * @param {*} name 
     */
    releaseCS(name)
    {
        if (this.mutexes[name] != undefined) this.mutexes[name].release();
    }

    loadDelayedEvents()
    {
        try 
        {
          if (fs.existsSync(this.delayedEventsFilename)) // Check if file exists
          {
            const rawData = fs.readFileSync(this.delayedEventsFilename); // Read data synchronously
            const data = JSON.parse(rawData); // Parse and load data
            this.delayedEvents=data;
          }
        } catch (error) 
        {
          console.error('Failed to load delayed events:', error);
        }
    }

    saveDelayedEvents() 
    {
        let data = this.delayedEvents; 
        try 
        {
          fs.writeFileSync(this.delayedEventsFilename, JSON.stringify(data)); // Save data synchronously
          //console.log('Data saved successfully.');
        } catch (error) 
        {
          console.error('Failed to delayed events:', error);
        }
    }

    async processDelayedEvents()
    {
        let newDelayedEvents = [];
        let actualDelayedEvents = [];
        const now=Date.now();
        this.delayedEvents.forEach( de => { if (de.time<=now) actualDelayedEvents.push(de); else newDelayedEvents.push(de); } );
        actualDelayedEvents.sort( (a,b) => b.time-a.time);
        actualDelayedEvents.forEach(de=> setTimeout( () => { this.processDelayedEvent(de); } ,100) );
        if (newDelayedEvents.length != this.delayedEvents.lenght ) this.saveDelayedEvents();
        this.delayedEvents = newDelayedEvents;

    }

    async processDelayedEvent(delayedEvent)
    {

    }


    /**
     * Register your API endpoints
     * @param {*} app Node.js express app to register into
     * @param {*} prefix Prefix that the extension is registered into
     * Example:
     *   app.post('/'+prefix+'api/test', (req, res) => { this.requestTest(req, res); });
     *   //will register POST method for path api/test (in configured prefix) that will call method requestTest
     */
    register(app,prefix)
    {
        app.get('/'+prefix+'api/test', (req, res) => { this.requestTest(req, res); });
        app.post('/'+prefix+'api/test', (req, res) => { this.requestTest(req, res); });
        app.post('/'+prefix+'api/basicinfo', async (req, res) => { await this.requestBasicInfo(req, res); });
        app.post('/'+prefix+'api/basicinfocacheid', async (req, res) => { await this.requestBasicInfoCacheId(req, res); });
        app.post('/'+prefix+'api/config', async (req, res) => { await this.requestConfig(req, res); });
        app.post('/'+prefix+'api/configsave', async (req, res) => { await this.requestConfigSave(req, res); });   
        app.post('/'+prefix+'webhook', async (req, res) => { await this.requestWebHook(req, res); });                   
        app.get('/'+prefix+'metrics', async (req, res) => { await this.requestMetrics(req, res); });                   
    }



    /**
     * This method is called from run.js for periodical events
     * @param {*} argv command line arguments
     */
    async run(argv)
    {
        //console.log('run',argv);
    }

    

     /**
     * Semi internal method to call Chaster API with get method
     *
     * @param url - part url after chasterBaseUrl
     * @param additionalInfo - javascript object that will receive additional information - most importantly the response
     * @returns object with parsed  response
     */
    async APIGet(url,additionalInfo=null)
    {
        const logId=((additionalInfo!=null)&&(additionalInfo.logId!=undefined))?additionalInfo.logId:'';
        try 
        {
            this.start_profile('api'+url);    
            const fullurl=this.chasterBaseUrl+url;            
            if (this.debugAPICall) console.log(logId,'API Get',fullurl);
            const headers = {"Authorization": "Bearer "+this.token};
            if (this.debugAPICall) console.log(logId,{"headers":headers});
            const response = await fetch(fullurl,  {"headers": headers, "method": "GET" }); 
            if (this.debugAPICall) console.log(logId,response.status);
            const t=this.end_profile('api'+url);
            if (additionalInfo != null) { additionalInfo.status=response?.status,additionalInfo.statustext=response?.statusText;}
            if (this.profileAPICall) console.log(logId,'API GET '+url+' took '+t.toFixed(3)+'ms','result:',response?.status+' '+response?.statusText);
            let data= null;
            try { data=await response.json(); } catch (error) { }
            return(data);
        } catch (error) 
        {
            console.log(logId,'Fetch GET error for URL: ',url,error);
            return(null);
        }
    }

     /**
     * Semi internal method to call Chaster API with POST method
     *
     * @param url - part url after chasterBaseUrl
     * @param body - JavascriptObject containing the post data (this method will convert it to string)
     * @param additionalInfo - javascript object that will receive additional information - most importantly the response
     * @returns object with parsed  response
     */
    async APIPost(url,body,additionalInfo=null)
    {
        const logId=((additionalInfo!=null)&&(additionalInfo.logId!=undefined))?additionalInfo.logId:'';
        try 
        {
            const fullurl=this.chasterBaseUrl+url;
            if (this.debugAPICall) console.log(logId,'API POST',fullurl,body);
            this.start_profile('api'+url);
            const headers = {"Authorization": "Bearer "+this.token, 'Content-Type': 'application/json'};
            if (this.debugAPICall) console.log(logId,{"headers":headers});
            const response = await fetch(fullurl,  {"headers": headers, "method": "POST", "body": JSON.stringify(body) }); 
            if (this.debugAPICall) console.log(logId,response.status+' '+response.statusText);
            const t=this.end_profile('api'+url);
            if (this.profileAPICall) console.log(logId,'API POST '+url+' took '+t.toFixed(3)+'ms','result:',response?.status+' '+response?.statusText);
            if (additionalInfo != null) {  additionalInfo.status=response?.status,additionalInfo.statustext=response?.statusText; /*if (this.chance(2)){ additionalInfo.status=505;}*/}
            let data=null;
            try { data=await response.json(); } catch (error) { }
            return(data);
        } catch (error) 
        {
            console.log(logId,'Fetch POST error for URL: ',url,error);
            return(null);
        }
    }

     /**
     * Semi internal method to call Chaster API with PUT method
     *
     * @param url - part url after chasterBaseUrl
     * @param body - JavascriptObject containing the put data (this method will convert it to string)
     * @param additionalInfo - javascript object that will receive additional information - most importantly the response
     * @returns object with parsed  response
     */
     async APIPut(url,body,additionalInfo=null)
     {
         const logId=((additionalInfo!=null)&&(additionalInfo.logId!=undefined))?additionalInfo.logId:'';        
         try 
         {
            this.start_profile('api'+url);
            const fullurl=this.chasterBaseUrl+url;
             if (this.debugAPICall) console.log(logId,'API PUT',fullurl,body);
             const headers = {"Authorization": "Bearer "+this.token, 'Content-Type': 'application/json'};
             if (this.debugAPICall) console.log(logId,{"headers":headers});
             const response = await fetch(fullurl,  {"headers": headers, "method": "PUT", "body": JSON.stringify(body) }); 
             if (this.debugAPICall) console.log(logId,response.status+' '+response.statusText);
             const t=this.end_profile('api'+url);
             if (this.profileAPICall) console.log(logId,'API PUT '+url+' took '+t.toFixed(3)+'ms','result:',response?.status+' '+response?.statusText);
             if (additionalInfo != null) {  additionalInfo.status=response?.status,additionalInfo.statustext=response?.statusText;}
             let data=null;
             try { data=await response.json(); } catch (error) { }
             return(data);
         } catch (error) 
         {
             console.log(logId,'Fetch PUT error for URL: ',url,error);
             return(null);
         }
     }

     /**
     * Semi internal method to call Chaster API with PATCH method
     *
     * @param url - part url after chasterBaseUrl
     * @param body - JavascriptObject containing the patch data (this method will convert it to string)
     * @param additionalInfo - javascript object that will receive additional information - most importantly the response 
     * @returns object with parsed  response
     */
     async APIPatch(url,body,additionalInfo=null)
     {
         const logId=((additionalInfo!=null)&&(additionalInfo.logId!=undefined))?additionalInfo.logId:'';
         try 
         {
            this.start_profile('api'+url);
            const fullurl=this.chasterBaseUrl+url;
             if (this.debugAPICall) console.log(logId,'API PATCH',fullurl,body);
             const headers = {"Authorization": "Bearer "+this.token, 'Content-Type': 'application/json'};
             if (this.debugAPICall) console.log(logId,{"headers":headers});
             const response = await fetch(fullurl,  {"headers": headers, "method": "PATCH", "body": JSON.stringify(body) }); 
             if (this.debugAPICall) console.log(logId,response.status+' '+response.statusText);
             const t=this.end_profile('api'+url);
             if (this.profileAPICall) console.log(logId,'API PATCH '+url+' took '+t.toFixed(3)+'ms','result:',response?.status+' '+response?.statusText);
             if (additionalInfo != null) {  additionalInfo.status=response?.status,additionalInfo.statustext=response?.statusText; /*if (this.chance(3)){ additionalInfo.status=505;}*/}
             let data=null;
             try { data=await response.json(); } catch (error) { }
             return(data);
         } catch (error) 
         {
             console.log(logId,'Fetch PATCH error for URL: ',url,error);
             return(null);
         }
     }

     sleep(ms) 
     {
        return new Promise(resolve => setTimeout(resolve, ms));
      }

     async APICall(logId,method,url,data=null,retries=1,critical=false,unrecoverableErrors=[],additionalInfo=null)
     {
        let ai={};
        let tryidx=0;
        let responsedata=null;
        const apicallId=this.generateRandomIdentifier(8);
        const sleeptimes=[0,0,500,1500,3000,6000,15000,30000,30000,30000,30000,30000,30000];
        ai.logId=logId+' '+apicallId
        while (tryidx < retries)
        {
            tryidx++;
            if (tryidx>1) 
            {
                const sleeptime=sleeptimes[tryidx];//(tryidx-1)*3000;
                if (this.debug) console.log(logId+' '+apicallId,'Sleeping for',sleeptime,' before next try');
                await this.sleep(sleeptime);
            }
            if (this.debug) console.log(logId+' '+apicallId,'API Call '+method+' '+url,'try',tryidx,'retries',retries,'critical',critical);
            switch (method) 
            {
                case 'PATCH': responsedata = await this.APIPatch(url,data,ai);break;
                case 'POST':  responsedata =await this.APIPost(url,data,ai);break;
                case 'PUT':   responsedata =await this.APIPut(url,data,ai);break;
                case 'GET':   responsedata =await this.APIGet(url,ai);break;
            }
            if (additionalInfo!=null) additionalInfo=ai;
            if ((ai.status >= 200) && (ai.status <299))
            {
                console.log(logId+' '+apicallId,'API Call for '+url+' succeeded on try ',tryidx,' with',ai.status,ai.statustext);
                this.stats.statsCounterInc('api_call','{url="'+(url.replace(logId,'<id>'))+'",method="'+method+'",result="success",status="'+ai.status+' '+ai.statustext+'",try="'+tryidx.toString()+'"}');
                return (responsedata); 
            }
            else
            {
                console.log(logId+' '+apicallId,'API Call for '+url+' failed with',ai.status,ai.statustext);                
                this.stats.statsCounterInc('api_call','{url="'+(url.replace(logId,'<id>'))+'",method="'+method+'",result="failed",status="'+ai.status+' '+ai.statustext+'",try="'+tryidx.toString()+'"}');
                if (unrecoverableErrors.includes(ai.status)) 
                {
                    this.stats.statsCounterInc('api_call','{url="'+(url.replace(logId,'<id>'))+'",method="'+method+'",result="unrecoverable",status="'+ai.status+' '+ai.statustext+'",try="'+tryidx.toString()+'"}');
                    if (this.debug) console.log(logId+' '+apicallId,'Unrecoverable error, aborting');
                    return(null);
                }
            }
        }
        if (critical)
        {
            if (this.debug) console.log(logId+' '+apicallId,'CRITICAL API Call for '+url+' exhausted all tries');
            this.stats.statsCounterInc('api_exhausted','{url="'+(url.replace(logId,'<id>'))+'",method="'+method+'",result="exhausted",critical="true",status="'+ai.status+' '+ai.statustext+'"}');
        }
        else
        {
            if (this.debug) console.log(logId+' '+apicallId,'NONcritical API Call for '+url+' exhausted all tries');
            this.stats.statsCounterInc('api_exhausted','{url="'+(url.replace(logId,'<id>'))+'",method="'+method+'",result="exhausted",critical="false",status="'+ai.status+' '+ai.statustext+'"}');
        }
     }

     /**
     * Lookup session for mainToken - useful for processing user request from main/configuration page
     *
     * @param mainToken - mainToken as parsed from URL of the  main or configuraion page
     * @returns object with the session
     * 
     * Example:
     * {"session":{"role":"wearer","session":{"slug":"testension","displayName":"Testension","summary":"Test extension - do not use","subtitle":"Test extension - do not use","icon":"puzzle-piece","_id":"650619ef351e727f76c3b12a","config":{},"mode":"unlimited","regularity":3600,"userData":null,"nbActionsRemaining":-1,"isPartner":true,"textConfig":"","createdAt":"2023-09-16T21:11:11.917Z","updatedAt":"2023-09-16T21:11:11.968Z","sessionId":"REzDsFO05Fll4gBL9jfLY","data":{},"metadata":{"reasonsPreventingUnlocking":[],"homeActions":[],"penalties":[]},"lock":{"_id":"650619ef351e727f76c3b119","startDate":"2023-09-16T21:11:11.000Z","endDate":"2023-09-16T23:09:59.000Z","minDate":"2023-09-16T22:11:11.000Z","maxDate":"2023-09-16T23:11:11.000Z","maxLimitDate":null,"displayRemainingTime":true,"limitLockTime":false,"status":"locked","combination":"650619ef9ce3ab70ce399450","sharedLock":null,"createdAt":"2023-09-16T21:11:11.748Z","updatedAt":"2023-09-16T21:11:12.022Z","unlockedAt":null,"archivedAt":null,"frozenAt":null,"keyholderArchivedAt":null,"totalDuration":2928864,"allowSessionOffer":false,"isTestLock":true,"offerToken":"b4533531-78e2-4fe9-ad9c-054b1aef31fd","hideTimeLogs":false,"trusted":false,"user":{"_id":"62c0aee9b4d3002c00185c75","username":"MobyDick666","isPremium":true,"description":"","location":"","gender":"Male","age":null,"role":"wearer","isFindom":false,"avatarUrl":"https://api.chaster.app/users/avatar/default_avatar.jpg","online":true,"lastSeen":null,"isAdmin":false,"isModerator":false,"metadata":{"locktober2020Points":0,"locktober2021Points":0,"chastityMonth2022Points":0,"locktober2022Points":1530},"fullLocation":"","discordId":"781942343355465760","discordUsername":"BigK#9992","isDisabled":false,"isSuspended":false,"features":[],"joinedAt":"2022-07","isNewMember":false,"isSuspendedOrDisabled":false},"keyholder":null,"isAllowedToViewTime":true,"canBeUnlocked":false,"canBeUnlockedByMaxLimitDate":false,"isFrozen":false,"extensions":[],"title":"Self-lock","lastVerificationPicture":null,"reasonsPreventingUnlocking":[],"extensionsAllowUnlocking":true}},"lockForUser":{"_id":"650619ef351e727f76c3b119","startDate":"2023-09-16T21:11:11.000Z","endDate":"2023-09-16T23:09:59.000Z","minDate":"2023-09-16T22:11:11.000Z","maxDate":"2023-09-16T23:11:11.000Z","maxLimitDate":null,"displayRemainingTime":true,"limitLockTime":false,"status":"locked","combination":"650619ef9ce3ab70ce399450","sharedLock":null,"createdAt":"2023-09-16T21:11:11.748Z","updatedAt":"2023-09-16T21:11:12.022Z","unlockedAt":null,"archivedAt":null,"frozenAt":null,"keyholderArchivedAt":null,"totalDuration":2928866,"allowSessionOffer":false,"isTestLock":true,"offerToken":"b4533531-78e2-4fe9-ad9c-054b1aef31fd","hideTimeLogs":false,"trusted":false,"user":{"_id":"62c0aee9b4d3002c00185c75","username":"MobyDick666","isPremium":true,"description":"","location":"","gender":"Male","age":null,"role":"wearer","isFindom":false,"avatarUrl":"https://api.chaster.app/users/avatar/default_avatar.jpg","online":true,"lastSeen":null,"isAdmin":false,"isModerator":false,"metadata":{"locktober2020Points":0,"locktober2021Points":0,"chastityMonth2022Points":0,"locktober2022Points":1530},"fullLocation":"","discordId":"781942343355465760","discordUsername":"BigK#9992","isDisabled":false,"isSuspended":false,"features":[],"joinedAt":"2022-07","isNewMember":false,"isSuspendedOrDisabled":false},"keyholder":null,"isAllowedToViewTime":true,"canBeUnlocked":false,"canBeUnlockedByMaxLimitDate":false,"isFrozen":false,"extensions":[],"role":"wearer","title":"Self-lock","lastVerificationPicture":null,"availableHomeActions":[],"reasonsPreventingUnlocking":[],"extensionsAllowUnlocking":true},"userId":"62c0aee9b4d3002c00185c75"}}
     */
    async getSessionForMainToken(mainToken)
    {
        const session= await this.APICall(mainToken,'GET','auth/sessions/'+mainToken,null,3,false,[401,404]);
        if (session?.session?.sessionId != undefined) this.mainTokenCache.store(mainToken,session?.session?.sessionId); else this.mainTokenCache.invalidate(mainToken);
        return (session);
    }

    /**
     * Get user data from Chaster. This is alternative to store them locally in LowDB or other
     * @param {*} sessionID Session ID 
     * @returns 
     */
    async getUserData(sessionID)
    {
        const userData= await this.APICall(sessionID,'GET','sessions/'+sessionID,null,5,false,[401,404]);
        return (userData.session.data);
    }

    /**
     * Store user data to the Chaster. This is alternative to store them locally in LowDB or other
     * @param {*} sessionID Session ID
     * @param {*} userData userdata to store
     * @returns 
     */
    async storeUserData(sessionID,userData)
    {
        this.basicInfoCache.invalidate(sessionID);        
        const rv= await this.APICall(sessionID,'PATCH','sessions/'+sessionID,{"data":userData},5,true,[401,404]);
        return (rv);
    }

    /**
     * Get session data from Chaster. 
     * @param {*} sessionID Session ID 
     * @returns 
     */
    async getSession(sessionID)
    {
        const session= await this.APICall(sessionID,'GET','sessions/'+sessionID,null,5,false,[401,404]);
        return (session);
    }    

    /**
     * Get session metadata from Chaster.
     * @param {*} sessionID Session ID
     * @returns 
     */
    async getSessionMetaData(sessionID)
    {
        const userData= await this.APICall(sessionID,'GET','sessions/'+sessionID,null,5,false,[401,404]);
        return (userData.session.metadata);
    }

    /**
     * Store session metadata to the Chaster. 
     * @param {*} sessionID Session ID
     * @param {*} metaData metadata to store. Only metaData.homeActions and metaData.reasonsPreventingUnlocking are stored.
     * @returns 
     */
    async storeSessionMetaData(sessionID,metaData)
    {
        this.basicInfoCache.invalidate(sessionID);
        const rv= await this.APICall(sessionID,'PATCH','sessions/'+sessionID,{"metadata":{"reasonsPreventingUnlocking":metaData.reasonsPreventingUnlocking,"homeActions":metaData.homeActions}},5,true,[401,404]);
        //const rv= await this.APIPatch('sessions/'+sessionID,{"metadata":{"reasonsPreventingUnlocking":metaData.reasonsPreventingUnlocking,"homeActions":metaData.homeActions}});
        return (rv);
    } 

    /**
     * Store session config to the Chaster. 
     * @param {*} sessionID Session ID
     * @param {*} config config to store. 
     * @returns 
     */
    async storeSessionConfig(sessionID,config)
    {
        this.basicInfoCache.invalidate(sessionID);
        const rv= await this.APICall(sessionID,'PATCH','sessions/'+sessionID,{"config":config},5,true,[401,404]);
        return (rv);
    }     
    
    /**
     * Get regular actions for the session
     * @param {*} sessionID Session ID
     * @returns 
     */
    async getRegularActions(sessionID)
    {
        const actions= await this.APICall(sessionID,'GET','sessions/'+sessionID+'/regular-actions',null,3,false,[401,404]);
        return (actions);
    }

    /**
     * Submit regular action
     * @param {*} sessionID Session ID
     * @param {*} payload payload of the action
     * @returns true if success
     */
    async submitRegularAction(sessionID,payload)
    {
        this.basicInfoCache.invalidate(sessionID);
        let ai={"status":0};
        const rv= await this.APICall(sessionID,'POST','sessions/'+sessionID+'/regular-actions',{"payload":payload},5,true,[401,404,422],ai);
        return (ai.status==201);  
    }


    
    /**
     * Lookup configuration object  retrieve the current configuration to be edited, depending on the context. For example:
     * When a keyholder edits the extension during a session, we will provide the configuration of the current session.
     * When a wearer creates a self-lock, and clicks on “Configure” for the first time, we will provide the default configuration.
     * @param configurationToken  configuration token as parsed from URL of the  configuraion page
     * @returns object with the configuration
     */
    async getConfigurationForConfigurationToken(configurationToken)
    {
        const config= await this.APICall(configurationToken,'GET','configurations/'+configurationToken,null,3,false,[401,404]);
        return (config);
    }

   

    /**
     * Save configuration
     * 
     * 
     * @param configurationToken  configuration token as parsed from URL of the  configuraion page
     * @returns object with the configuration
     */
    async saveConfigurationForConfigurationToken(configurationToken,config)
    {
        const newconfig= await this.APICall(configurationToken,'PUT','configurations/'+configurationToken,{"config":config.config},5,false,[401,404]);
        return (newconfig);
    }        

     /**
     * Generic lock action. If you do not know how to use it - use specific functions like add_time
     * @param sessionID Lock session ID
     * @param actionData data with the action specification
     * @returns Chaster response
     * 
     * Example of action data
     * actionData={
     *      "action": 
     *          {  
     *              "name": "remove_time",
     *              "params": 300 // The amount of time to remove, in seconds
     *           }
     */
    async lockAction(sessionID,actionData)
    {
        this.basicInfoCache.invalidate(sessionID);
        const rv= await this.APICall(sessionID,'POST','sessions/'+sessionID+'/action',actionData,5,true,[401,404]);
        return(rv);
    }

    /**
     * Add time (in seconds) to lock
     * @param sessionID Lock session ID
     * @param secs Time in seconds to add
     */
    async addTime(sessionID,secs)
    {
        return (this.lockAction(sessionID,{"action":{"name":"add_time","params":secs}}));
    }

    /**
     * Remove time (in seconds) from lock
     * @param sessionID Lock session ID
     * @param secs Time in seconds to remove
     */
    async removeTime(sessionID,secs)
    {
        return (this.lockAction(sessionID,{"action":{"name":"remove_time","params":secs}}));
    }

    /**
     * Freeze lock
     * @param sessionID Lock session ID
     */
    async freeze(sessionID)
    {
        return (this.lockAction(sessionID,{"action":{"name":"freeze"}}));
    }

    /**
    * Unfreeze lock
    * @param sessionID Lock session ID
    */
    async unfreeze(sessionID)
    {
        return (this.lockAction(sessionID,{"action":{"name":"unfreeze"}}));
    }    

    /**
    * Togle freeze status of the lock
    * @param sessionID Lock session ID
    */
    async toggleFreeze(sessionID)
    {
        return (this.lockAction(sessionID,{"action":{"name":"toggle_freeze"}}));
    }  

    /**
    * Send lock to pillory
    * @param sessionID Lock session ID
    * @param secs Pillory duration in seconds 
    * @param reason Text with the pillory reason
    */
    async pillory(sessionID,secs,reason)
    {
        return (this.lockAction(sessionID,{"action":{"name":"pillory","params":{"duration":secs,"reason":reason}}}));
    } 

    /**
     * Set reasons to prevent unlocking
     * @param {*} sessionID Session ID
     * @param {*} reasons null or empty string means that the lock can be unlocked. String or array of strings provides reasons blocking unlocking
     */
    async setReasonsPreventingUnlocking(sessionID,reasons)
    {
        this.basicInfoCache.invalidate(sessionID);
        let metaData= await this.getSessionMetaData(sessionID);
        if (reasons=="null")
        {
            reasons=[];
        }
        else if (typeof(reasons)=="string")
        {   
            if (reasons=="") reasons=[]; else reasons=[reasons];
        }
        metaData["reasonsPreventingUnlocking"]=reasons;
        await this.storeSessionMetaData(sessionID, metaData);

    }
    
    /**
    * Send custom log message to lock history
    * @param sessionID Lock session ID
    * @param role Initiator of the message: user, keyholder, or extension
    * @param title  Specifies the title of the log action. This should be a brief summary or headline for the action.
    * @param description Specifies the detailed description or additional information about the log action.
    * @param color Specifies the color of the log action. This parameter accepts a hexadecimal color code (e.g., #FF0000 for red).
    * @param icon pecifies the FontAwesome icon to be displayed in the log entry. The icon should be chosen from the FontAwesome v5 regular icons collection.
    */
    async customLogMessage(sessionID,role,title,description,color,icon)
    {
        this.basicInfoCache.invalidate(sessionID);
        if (role==="wearer") role="user";
        const log=
         {
             "role": role,
             "icon": icon,
             "color": color,
             "title": title,
             "description": description
           };
           const rv= await this.APICall(sessionID,'POST','sessions/'+sessionID+'/logs/custom',log,5,true,[401,404,422]);
           return(rv); 
    }

   /* async lockSettings(lockID,sessionID,settingData)
    {
        this.basicInfoCache.invalidate(sessionID);
        const rv= await this.APICall(sessionID,'POST','locks/'+lockID+'/settings',settingData,3,true,[400,401,403,404],{usePublicAPI:true});
        return(rv);
    }

    async setLockTimerVisibility(session,displayRemainingTime=null,hideTimeLogs=null)
    {
        const sessionID = session?.session?.sessionId;
        const lockID=session?.session?.lock?._id;
        console.log('ses',sessionID);
        console.log('lockID',lockID);
        if ((lockID != undefined) && (sessionID != undefined))
        {
            const data={"displayRemainingTime": (displayRemainingTime==null)?session?.session?.lock?.displayRemainingTime:displayRemainingTime,"hideTimeLogs": (hideTimeLogs==null)?session?.session?.lock?.hideTimeLogs:hideTimeLogs};
            const rv=await this.lockSettings(lockID,sessionID,data);
            return (rv);
        }
        return (null);

    }
    */

    /**
    * Find all sessions for extensionSlug
    * @param extensionSlug Slug of the extensin to search for
    * @param searchCount Number of sessions to download at once (default 15)
    * @retuns Object with sessions
    * 
    * Example:
    * {
    *    count: 1,
    *    hasMore: false,
    *    results: [
    *      {
    *        slug: 'testension',
    *        displayName: 'Testension',
    *        summary: 'Test extension - do not use',
    *        subtitle: 'Test extension - do not use',
    *        icon: 'puzzle-piece',
    *        _id: '650619ef351e727f76c3b12a',
    *        config: {},
    *        mode: 'unlimited',
    *        regularity: 3600,
    *        userData: null,
    *        nbActionsRemaining: -1,
    *        isPartner: true,
    *        textConfig: '',
    *        createdAt: '2023-09-16T21:11:11.917Z',
    *        updatedAt: '2023-09-16T21:11:11.968Z',
    *        sessionId: 'REzDsFO05Fll4gBL9jfLY',
    *        data: {},
    *        metadata: [Object],
    *        lock: [Object],
    *        paginationId: '650619ef351e727f76c3b119'
    *     }
    *   ]
    * }
    */
    async findAllSessions(extensionSlug,searchCount=30)
    {
        let sessions=await this.searchSessions(extensionSlug);
        while (sessions.hasMore)
        {
            const sessionsNext=await this.searchSessions(extensionSlug,searchCount,sessions.results[sessions.results.length-1].paginationId);
            sessions.hasMore=sessionsNext.hasMore;
            sessions.results.push(...sessionsNext.results);
        }
        return(sessions);
    }

    /**
     * search Sessions - single API call for sessions lookup. Limited to 15 results and expects upper level to deal with that.
     * @param {*} extensionSlug Slug of the extensin to search for
     * @param {*} limit Limit, default 15
     * @param {*} paginationLastId  paginationId of last result
     * @returns 
     */
    async searchSessions(extensionSlug,limit=undefined,paginationLastId=undefined)
    {
        let opts={"extensionSlug":extensionSlug};
        if (limit != undefined) opts.limit=limit;
        if (paginationLastId != undefined) opts.paginationLastId=paginationLastId;
        const sessions= await this.APICall(extensionSlug,'POST','sessions/search',opts,3,true,[401,404,422]);
        return(sessions);
    }



    /**
    * Utility function to convert time in format 2023-09-17T11:47:34.000Z to seconds remaining
    * @param endTime time in format 2023-09-17T11:47:34.000Z
    * @param startTime optional start Time in format 2023-09-17T11:47:34.000Z
    * @retuns Remaining time in seconds. If the time is in past it will be negative
    */
    timeRemaining(endTime,startTime=null)
    {
        const endDate = new Date(endTime);
        const now=(startTime==null)?new Date():new Date(startTime);
        return ((endDate-now)/1000);
    }

    /**
     * Test stub for API test (ping) 
     * 
     */
    async requestTest(req, res)
    {
        //console.log(req.body.mainToken);
        //const session = await this.getSessionForMainToken(req.body.mainToken);
        return res.status(200).send(JSON.stringify({'response':'API Ready'}));
    }

    regularActionInfo(session)
    {

        let result={'available':false,mode:null,actionsRemaining:null,nextActionDate:null,regularity:null,nextActionIn:null};
        //cumulative, non_cumulative, turn, unlimited
        result.mode=session.mode;
        switch (session.mode) 
        {
            case 'cumulative':
            case 'non_cumulative':                
                result.actionsRemaining=session.nbActionsRemaining;
                result.nextActionDate=session.nextActionDate;
                result.available=result.actionsRemaining>0;  
                result.regularity=session.regularity;
                result.nextActionIn=(result.available)?0:this.timeRemaining(result.nextActionDate);
            break;
            
            case 'unlimited':
               result.actionsRemaining=-1;
               result.nextActionDate=null;
               result.available=true; 
               result.regularity=null;
               result.nextActionIn=0;
            break;                
        }

        return result;
    }


    
    async requestBasicInfoCacheId(req, res)
    {
        try
        {
            const sessionId=this.mainTokenCache.get(req.body.mainToken);
            if (sessionId==null) return res.status(200).send(JSON.stringify({cacheId:null,reason:'nosessionid'}));
            const cachedValue=this.basicInfoCache.get(sessionId);
            return res.status(200).send(JSON.stringify({cacheId:cachedValue}));
        }
        catch (err)
        {
            console.log(err);
            return res.status(501).send('Internal server error');
        }
    }

    /**
     * Returns the basic info about the session 
     * 
     */
    async requestBasicInfo(req, res)
    {
        try
        {
        //if (this.debug) console.log(req.body.mainToken);
            const session = await this.getSessionForMainToken(req.body.mainToken);
            if (session?.session?.sessionId ==undefined)
            {
                const basicInfo={"valid":false}
                return res.status(200).send(JSON.stringify(basicInfo));
            }
            else
            {
                const basicInfo=await this.processBasicInfo(session);
                const cacheId=this.hashSession(session);
                //console.log('nextActionIn',basicInfo.nextActionIn,typeof( basicInfo.nextActionIn));
                let timeout=(basicInfo.nextActionIn>0)?basicInfo.nextActionIn:( (basicInfo.mode=="cumulative")?basicInfo.regularity:null );
                timeout = Math.min(timeout,600); //limit timeout to 5 minutes
                timeout = Math.max(timeout,60); //limit timeout to at least 1 minute
                this.basicInfoCache.store(session.session.sessionId,cacheId,timeout );
                basicInfo.cacheId=cacheId;

                return res.status(200).send(JSON.stringify(basicInfo));
            }
        
        }
        catch (err)
        {
            console.log(err);
            return res.status(501).send('Internal server error');
        }
    }

    /**
     *  To be able to modify the basicinfo in the child extension
     */
    async processBasicInfo(session)
    {

        //console.log(session.session.sessionId,'Mode:',session.session.mode,'Regularity:',session.session.regularity,'nbActionsRemaining:',session.session.nbActionsRemaining,'nextActionDate',session.session.nextActionDate);
        const actionInfo=this.regularActionInfo(session.session);
        //const actions=await this.getRegularActions(session.session.sessionId);
        let avatar=session?.session?.lock?.user?.avatarUrl;
        let trusted=session?.session?.lock?.trusted;
        let keyholder=session?.session?.lock?.keyholder?.username;
        const bi={"valid":true,"role":session.role,"slug":session.session.slug,"config":session.session.config,nextActionIn:actionInfo.nextActionIn,actionsRemaining:actionInfo.actionsRemaining,mode:actionInfo.mode,regularity:actionInfo.regularity,"avatar":avatar,"trusted":trusted,keyholder:keyholder};

        return(bi);
    }

    /**
     * Returns the configuration info
     * 
     */
    async requestConfig(req, res)
    {
        try
        {
        //console.log(req.body.configurationToken);
        const config = await this.getConfigurationForConfigurationToken(req.body.configurationToken);
        return res.status(200).send(JSON.stringify(config));
        }
        catch
        {
            return res.status(501).send('Internal server error');
        }
    }    

    /**
         * Saves the configuration info
         * 
         */
    async requestConfigSave(req, res)
    {
        try
        {
            console.log('Saving config for token:',req.body.configurationToken,'config data',req.body.config);

            if (req.body.configurationToken)
            {
                let config=this.onBeforeConfigSave(req.body.config);
                const configRes = await this.saveConfigurationForConfigurationToken(req.body.configurationToken,config);
                return res.status(200).send(JSON.stringify(configRes));
            }
            
        }
        catch (error) 
        {
            console.log('RequestConfigSave exception',error);
            return res.status(501).send('Internal server error');
        }
    } 

    /**
     * Abstract handler called before the user submitted config is sent to chaster. Can be used to sanitize the config or to create textual config summary for handlebars
     * @param {*} config config as submitted by the user 
     * @returns sanitized/processed config
     */
    onBeforeConfigSave(config)
    {
        return(config);
    }

    async tryRegular(name,config,sessionId,userData)
    {
        let result=false;
        let regular=new Regular(name,config);
        regular.debugId=sessionId;
        regular.debug=this.debug;
        userData=regular.loadFromUserData(userData);
        if (regular.tryAction()) result=true;
        userData=regular.storeToUserData(userData);
        await this.storeUserData(sessionId,userData);
        return ({result:result,userData:userData});
    }

   

    async requestWebHook(req, res)
    {
        try
        {
            const data=req.body;
            if (this.debugWebHooks) console.log('webhook request',data);

            if (this.webhooks[data.event] != undefined) await this.webhooks[data.event](data,req,res);

            return res.status(200).send('OK');
        }
        catch
        {
            return res.status(501).send('Internal server error');
        }
        /*
       webhook request {
        event: 'extension_session.created',
        sentAt: '2023-10-24T19:18:01.855Z',
        requestId: 'EVLJgjCLr70w5j-UEwphg',
        data: {
            session: {
            slug: 'just-the-pillory',
            displayName: 'Just the Pillory',
            summary: 'Makes it possible to wearer to send *self to pillory.',
            subtitle: 'Send yourself to pillory',
            icon: 'puzzle-piece',
            _id: '6538186935e79c1063a25ba2',
            config: [Object],
            mode: 'unlimited',
            regularity: 60,
            userData: null,
            nbActionsRemaining: -1,
            isPartner: true,
            textConfig: '',
            createdAt: '2023-10-24T19:18:01.437Z',
            updatedAt: '2023-10-24T19:18:01.493Z',
            sessionId: 'J_vTGv_iivoa86Kpnm1-T',
            data: {},
            metadata: [Object],
            lock: [Object]
            },
            extension: { slug: 'just-the-pillory' }
        }
        }
        */
    }

    /**
     * Calculate radom number betweem min and max (inclusive)
     * @param {*} min 
     * @param {*} max 
     * @returns 
     */
    random(min, max)
    {
        return (Math.floor(Math.random() * (max - min + 1) + min));
    }

    /**
     * Generate random chance 1 in x
     * @param {*} oneIn 
     * @returns true if the random chance was 1 in x
     */
    chance(oneIn) 
    {
        if (oneIn <1) return true;
        return Math.random() < 1 / oneIn;
    }

    /**
     * Generate random percent chance
     * @param {*} pct pct chance, i.e. 25 => 1/4 chance
     * @returns true if the random chance was less than pct 
     */
    chancePct(pct) 
    {
        if ((pct == undefined) || (pct==null)) return false;
        if (pct <=0) return false;
        if (pct >=100) return true;
        return Math.random()*100 <= pct;
    }

    /**
     * Shuffle array in place
     * @param {*} array 
     * @returns 
     */
    shuffleInPlace(array) 
    {
        for (let i = array.length - 1; i > 0; i--) 
        {
          const j = Math.floor(Math.random() * (i + 1)); // Random index from 0 to i
          [array[i], array[j]] = [array[j], array[i]]; // Swap elements at indices i and j
        }
        return array;
    }

    /**
     * Format secons as human readable string
     * @param {*} secs seconds to format
     * @returns 
     */
    formatTimeString(secs) 
    {
        const hours = Math.floor(secs / 3600);
        const minutes = Math.floor((secs % 3600) / 60);
        const seconds = Math.floor(secs % 60);
        const times=[];
        if (hours > 1) times.push(`${hours} hours`);
        if (hours == 1) times.push(`${hours} hour`);
    
        if (minutes > 1) times.push(`${minutes} minutes`);
        if (minutes == 1) times.push(`${minutes} minute`);    
    
        if (seconds > 1) times.push(`${seconds} seconds`);
        if (seconds == 1) times.push(`${seconds} second`);  
        
        if (secs == 0) times.push('0 seconds');
    
        return(times.join(' and '));
    }

    async generateMetrics(metrics) 
    {
        return (metrics);
    }

    async requestMetrics(req, res)
    {
        if (this.debug) console.log('Requesting metrics from extension');
        let metrics='';
        metrics=await this.generateMetrics(metrics);
        //if (this.debug) console.log('Got metrics',metrics);
        return await this.stats.requestMetrics(req, res,metrics);
    }

    shutdown() 
    {


        if (this.delayedEventsFilename != null)
        {
          if (this.debug) console.log('Delayed events saved on shutdown.');
          this.saveDelayedEvents();
        }
 

        if (this.statsFilename != null) 
        {
            this.stats.saveStats(this.statsFilename);
            if (this.debug) console.log('Stats saved on shutdown.');
        }

        process.exit(0);
    }

    hashSession(session)
    {
        let hashData={};
        //console.log('Hashing session',session);
        ['config','data','metadata','mode','regularity','updatedAt'].forEach(k=>hashData[k]=session?.session[k]);
        ['status','trusted','canBeUnlocked','isFrozen','displayRemainingTime','limitLockTime','updatedAt','hideTimeLogs','isAllowedToViewTime'].forEach(k=>hashData[k]=session?.session?.lock[k]);
        const actionInfo=this.regularActionInfo(session.session);
        ['available','actionsRemaining'].forEach(k=>hashData[k]=actionInfo[k]);

        //console.log('Hash data super',hashData);

        return(this.hash(hashData))
    }


    hash (data)
    {
        // Create a hash object
        const hash = crypto.createHash('sha1');

        // Update the hash object with the input data
        hash.update(JSON.stringify(data));

        // Calculate the hash digest (result)
        const hashDigest = hash.digest('hex'); // 'hex' encoding outputs the digest as a hexadecimal string

        return(hashDigest);
    }

    async reloadSession(sessionId,session)
    {
        //console.log('session pre',session);
        const newSession= await this.getSession(sessionId);
        if (newSession.session != undefined) 
        { 
            session.session=newSession.session; 
            if (this.debug) console.log(sessionId,'session reloaded');
        }
        //console.log('session post',session);
        return (session);
    }
      
   
}

export {Extension};

