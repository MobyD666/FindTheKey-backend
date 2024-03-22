
import fetch from 'node-fetch';

import { config } from 'dotenv';
import path from 'path';
import fs from 'fs';

import {StatsSpooler,StatsCounter} from './StatsSpooler.js';

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

       
        
       this.debug = this.isTrue(this.config.DEBUG) || (this.config.NODE_ENV === 'development'); 
       this.debugAPICall = this.isTrue(this.config.DEBUGAPI) || (this.config.NODE_ENV === 'development'); 
       this.profileAPICall = this.isTrue(this.config.PROFILEAPI) || (this.config.NODE_ENV === 'development'); 
       this.debugWebHooks = this.isTrue(this.config.DEBUGWEBHOOKS) || (this.config.NODE_ENV === 'development'); 
       this.debugNew = this.isTrue(this.config.DEBUGNEW) || (this.config.NODE_ENV === 'development'); 
       this.chasterBaseUrl = this.config.CHASTERURL ||  'https://api.chaster.app/api/extensions/'
       this.statsFilename = this.config.STATSFILENAME ||  null;
       if (this.config.DEAD != undefined) this.dead=this.isTrue(this.config.DEAD);
       this.name = 'abstractExtension';
       this.slug = '';
       this.webhooks = {};
       this.profiles={};

       this.stats= new StatsSpooler(config);
       this.setupStats();

       if (this.statsFilename != null) 
       {
        this.stats.loadStats(this.statsFilename);
        setInterval(() => this.stats.saveStats(this.statsFilename), 60000); // Save every 60 seconds
       }

       process.on('SIGINT', () => this.shutdown());
       process.on('SIGTERM', () => this.shutdown());

    }

    isTrue(s)
    {
        return ((s===true) || ((typeof s == 'string') && ((s.toUpperCase()==="TRUE") || (s.toUpperCase==="ON"))));
    }

    setupStats()
    {
        //abstract
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
     * @returns object with parsed  response
     */
    async APIGet(url)
    {
        try 
        {
            this.start_profile('api'+url);        
            if (this.debugAPICall) console.log('API Get',this.chasterBaseUrl+url);
            const headers = {"Authorization": "Bearer "+this.token};
            if (this.debugAPICall) console.log({"headers":headers});
            const response = await fetch(this.chasterBaseUrl+url,  {"headers": headers, "method": "GET" }); 
            if (this.debugAPICall) console.log(response.status);
            const t=this.end_profile('api'+url);
            if (this.profileAPICall) console.log('API GET '+url+' took '+t.toFixed(3)+'ms');
            let data= null;
            try
            {
               data = await response.json();
            }
            catch (error) 
            {
                data = null;
            }
            return(data);
        } catch (error) 
        {
            console.log('Fetch GET error for URL: ',url,error);
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
        try 
        {
            if (this.debugAPICall) console.log('API POST',this.chasterBaseUrl+url,body);
            this.start_profile('api'+url);
            const headers = {"Authorization": "Bearer "+this.token, 'Content-Type': 'application/json'};
            if (this.debugAPICall) console.log({"headers":headers});
            const response = await fetch(this.chasterBaseUrl+url,  {"headers": headers, "method": "POST", "body": JSON.stringify(body) }); 
            if (this.debugAPICall) console.log(response.status+' '+response.statusText);
            const t=this.end_profile('api'+url);
            if (this.profileAPICall) console.log('API POST '+url+' took '+t.toFixed(3)+'ms');
            if (additionalInfo != null) additionalInfo.response = response;
            let data=null;
            try
            {
               data = await response.json();
            }
            catch (error) 
            {
                data = null;
            }
            return(data);
        } catch (error) 
        {
            console.log('Fetch POST error for URL: ',url,error);
            return(null);
        }
    }

     /**
     * Semi internal method to call Chaster API with PUT method
     *
     * @param url - part url after chasterBaseUrl
     * @param body - JavascriptObject containing the put data (this method will convert it to string)
     * @returns object with parsed  response
     */
     async APIPut(url,body)
     {
         try 
         {
            this.start_profile('api'+url);
             if (this.debugAPICall) console.log('API PUT',this.chasterBaseUrl+url,body);
             const headers = {"Authorization": "Bearer "+this.token, 'Content-Type': 'application/json'};
             if (this.debugAPICall) console.log({"headers":headers});
             const response = await fetch(this.chasterBaseUrl+url,  {"headers": headers, "method": "PUT", "body": JSON.stringify(body) }); 
             if (this.debugAPICall) console.log(response.status+' '+response.statusText);
             const t=this.end_profile('api'+url);
             if (this.profileAPICall) console.log('API PUT '+url+' took '+t.toFixed(3)+'ms');             
             let data=null;
             try
             {
                data = await response.json();
             }
             catch (error) 
             {
                 data = null;
             }
             return(data);
         } catch (error) 
         {
             console.log('Fetch PUT error for URL: ',url,error);
             return(null);
         }
     }

     /**
     * Semi internal method to call Chaster API with PATCH method
     *
     * @param url - part url after chasterBaseUrl
     * @param body - JavascriptObject containing the patch data (this method will convert it to string)
     * @returns object with parsed  response
     */
     async APIPatch(url,body)
     {
         try 
         {
            this.start_profile('api'+url);
             if (this.debugAPICall) console.log('API PATCH',this.chasterBaseUrl+url,body);
             const headers = {"Authorization": "Bearer "+this.token, 'Content-Type': 'application/json'};
             if (this.debugAPICall) console.log({"headers":headers});
             const response = await fetch(this.chasterBaseUrl+url,  {"headers": headers, "method": "PATCH", "body": JSON.stringify(body) }); 
             if (this.debugAPICall) console.log(response.status+' '+response.statusText);
             const t=this.end_profile('api'+url);
             if (this.profileAPICall) console.log('API PATCH '+url+' took '+t.toFixed(3)+'ms');             
             let data=null;
             try
             {
                data = await response.json();
             }
             catch (error) 
             {
                 data = null;
             }
             return(data);
         } catch (error) 
         {
             console.log('Fetch PATCH error for URL: ',url,error);
             return(null);
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
        const session= await this.APIGet('auth/sessions/'+mainToken);
        return (session);
    }

    /**
     * Get user data from Chaster. This is alternative to store them locally in LowDB or other
     * @param {*} sessionID Session ID 
     * @returns 
     */
    async getUserData(sessionID)
    {
        const userData= await this.APIGet('sessions/'+sessionID);
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
        const rv= await this.APIPatch('sessions/'+sessionID,{"data":userData});
        return (rv);
    }

    /**
     * Get session data from Chaster. 
     * @param {*} sessionID Session ID 
     * @returns 
     */
    async getSession(sessionID)
    {
        const session= await this.APIGet('sessions/'+sessionID);
        return (session);
    }    

    /**
     * Get session metadata from Chaster.
     * @param {*} sessionID Session ID
     * @returns 
     */
    async getSessionMetaData(sessionID)
    {
        const userData= await this.APIGet('sessions/'+sessionID);
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
        const rv= await this.APIPatch('sessions/'+sessionID,{"metadata":{"reasonsPreventingUnlocking":metaData.reasonsPreventingUnlocking,"homeActions":metaData.homeActions}});
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
        const rv= await this.APIPatch('sessions/'+sessionID,{"config":config});
        return (rv);
    }     
    
    /**
     * Get regular actions for the session
     * @param {*} sessionID Session ID
     * @returns 
     */
    async getRegularActions(sessionID)
    {
        const actions= await this.APIGet('sessions/'+sessionID+'/regular-actions');
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
        let ai={"response":null};
        const rv= await this.APIPost('sessions/'+sessionID+'/regular-actions',{"payload":payload},ai);
        return (ai.response.status==201);  
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
        const config= await this.APIGet('configurations/'+configurationToken);
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
        console.log('tmp',config);
        const newconfig= await this.APIPut('configurations/'+configurationToken,{"config":config.config});
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
        return(this.APIPost('sessions/'+sessionID+'/action',actionData));        
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
        if (role==="wearer") role="user";
        const log=
         {
             "role": role,
             "icon": icon,
             "color": color,
             "title": title,
             "description": description
           };
           return(this.APIPost('sessions/'+sessionID+'/logs/custom',log)); 
    }

    /**
    * Find all sessions for extensionSlug
    * @param extensionSlug Slug of the extensin to search for
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
    async findAllSessions(extensionSlug)
    {
        let sessions=await this.searchSessions(extensionSlug);
        while (sessions.hasMore)
        {
            const sessionsNext=await this.searchSessions(extensionSlug,15,sessions.results[sessions.results.length-1].paginationId);
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
        const sessions=await this.APIPost('sessions/search',opts);
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

    /**
     * Returns the basic info about the session 
     * 
     */
    async requestBasicInfo(req, res)
    {
        try
        {
        if (this.debug) console.log(req.body.mainToken);
        const session = await this.getSessionForMainToken(req.body.mainToken);

        const actions=await this.getRegularActions(session.session.sessionId);
        const tr=this.timeRemaining(actions.nextActionDate);
        let avatar=session?.session?.lock?.user?.avatarUrl;
        let trusted=session?.session?.lock?.trusted;
        let keyholder=session?.session?.lock?.keyholder?.username;
        const basicInfo=await this.processBasicInfo(session,{"role":session.role,"slug":session.session.slug,"config":session.session.config,nextActionIn:tr,actionsRemaining:actions.nbActionsRemaining,"avatar":avatar,"trusted":trusted,keyholder:keyholder});
   
        return res.status(200).send(JSON.stringify(basicInfo));
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
    async processBasicInfo(session,bi)
    {
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
        console.log(req.body.configurationToken);
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
        if (this.debug) console.log('Got metrics',metrics);
        return await this.stats.requestMetrics(req, res,metrics);
    }

    shutdown() 
    {
        if (this.statsFilename != null) 
        {
            this.stats.saveStats(this.statsFilename);
            if (this.debug) console.log('Stats saved on shutdown.');
        }
        process.exit(0);
    }
      
   
}

export {Extension};

