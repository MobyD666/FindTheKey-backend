class  Regular
{
    

    /**
     * constructor - set up the regular. Call this from your constructor
     */
    constructor(name,config)
    {
        this.name = name;
        this.config = config;
        this.debug=true;
        this.debugMore=false;
        this.debugId='';
        this.data={};
    }

    loadFromUserData(userData)
    {
        const now=Date.now();
        if (this.debugMore) console.log(this.debugId,'loadFromUserData ',this.name,'Mode: ',this?.config?.mode,' Regularity: ',this.config?.regularity);
        if (userData.regulars != undefined) 
        {
            if (userData.regulars[this.name] != undefined) 
            {
                if (userData.regulars[this.name].data != undefined) this.data=userData.regulars[this.name].data;
                if (userData.regulars[this.name].config != undefined) this.config=userData.regulars[this.name].config;
            }
        }
        this.process(now);
        return (userData);
    }

    process(now=null)
    {
        if (now == null) now = Date.now();
        if (this.data == undefined) this.data = {};
        if (this.data.lastProcessing == undefined) 
        {
            //initial processing
            this.data.tries = (this.config.waitfirst===false)? 1 :0;
            this.data.lastProcessing = now;
            if (this.debug) console.log(this.debugId,'process ',this.name,'No last processing data found, setting defaults','tries',this.data.tries);    
        }
        else
        {
            const diff=(now - this.data.lastProcessing)/1000;
            if (diff>this.config.regularity) 
            {
                const oldTries=this.data.tries;
                this.data.tries+=diff/this.config.regularity;
                this.data.lastProcessing = now;
                if (this.debug) console.log(this.debugId,'process ',this.name,'More than regularity passed from last processing','diff secs',diff,'old tries',oldTries,'new tries',this.data.tries);                    
            }
        }

    }

    storeToUserData(userData)
    {
        const now=Date.now();
        if (this.debugMore) console.log(this.debugId,'storeToUserData ',this.name,'Mode: ',this?.config?.mode,' Regularity: ',this.config?.regularity, 'Last Processing: ',this?.data?.lastProcessing,'Now:',now,'Diff milisecs (from processing):',(now-this?.data?.lastProcessing),'tries',this.data.tries);
        if (userData.regulars == undefined)  userData.regulars = {};
        if (userData.regulars[this.name] == undefined)  userData.regulars[this.name] = {config:this.config,data:{}};
        userData.regulars[this.name].data = this.data;
        return (userData);
    }

    remainingCount(now=null)
    {
        let result=0;
        switch (this.config?.mode) 
        {
            case 'unlimited': result=1; break;
            case 'cumulative': result=Math.floor(this.data.tries); break;
            case 'non_cumulative': result=Math.floor(Math.min(this.data.tries,1)); break;
                
            default: result = 0; break;
        }

      
        if (this.debug) console.log(this.debugId,this.name,'remainingCount ',result,'Mode: ',this?.config?.mode,' Regularity: ',this.config?.regularity);
        return (result);
    }

    timeTillNext(now=null)
    {
        let result=null;
        if (now == null) now = Date.now();
        const rem=this.remainingCount(now);
        if (rem>0) result=0;
        else if (this.config.mode=='unlimited') result=0;
        else
        {
            const diff=(now-this.data.lastProcessing)/1000;
            result=Math.max(0,this.config.regularity-diff);
        }
        return (result);

    }

    tryAction()
    {
        let result=false;
        const now=Date.now();
        if (this.debugMore) console.log(this.debugId,'tryAction ',this.name,'Mode: ',this?.config?.mode,' Regularity: ',this.config?.regularity, 'Last Processing: ',this?.data?.lastProcessing,'Now:',now,'Diff milisecs (from processing):',(now-this?.data?.lastProcessing),'tries',this.data.tries);
        if (this.checkAction(now))
        {
            result = this.doAction(now);
        }
        return (result);
    }

    checkAction(now)
    {
        let result=false;
        if (this.debug) console.log(this.debugId,'checkAction ',this.name,'Mode: ',this?.config?.mode,' Regularity: ',this.config?.regularity, 'Last Processing: ',this?.data?.lastProcessing,'Now:',now,'Diff milisecs (from processing):',(now-this?.data?.lastProcessing),'tries',this.data.tries);
        switch (this?.config?.mode) 
        {
            case 'unlimited': result = true; break;
            case 'cumulative':
            case 'non_cumulative': 
                               result = this.remainingCount(now)>0; 
                               break;
            default:
            undefined:    
                result = false;
                break;
        }
        return (result);
    }

    doAction(now)
    {
        let result=false;
        if (this.debugMore) console.log(this.debugId,'doAction ',this.name,'Mode: ',this?.config?.mode,' Regularity: ',this.config?.regularity, 'Last Processing: ',this?.data?.lastProcessing,'Now:',now,'Diff milisecs (from processing):',(now-this?.data?.lastProcessing),'tries',this.data.tries);
        this.data.tries -= 1;
        this.data.lastAction = now;
        result=true;
        return(result);
    }





}


export {Regular};