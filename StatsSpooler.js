import { config } from 'dotenv';
import path from 'path';
import fs from 'fs';


class StatsCounter
{
    constructor(name,help,type='counter')
    {
        this.name=name;
        this.type=type;
        this.help=help;
        this.values={};
    }

    increment(subtype,value)
    {
        if (this.values[subtype]==undefined) this.values[subtype]= 0;
        this.values[subtype]+=value;
    }

    save()
    {
        return(this.values);
    }

    load(data)
    {
        this.values=data;
    }

    generateMetrics()
    {
        let metrics='';
        metrics +="#HELP "+this.name+" "+this.help+"\n#TYPE "+this.name+" "+this.type+"\n";
        Object.keys(this.values).forEach(k=> metrics += this.name+k+" "+this.values[k]+"\n");
        return metrics;
    }
}

class StatsSpooler
{
    constructor(config)
    {
        this.stats={};
        this.loaded=false;
    }

    addStat(newStat)
    {
        this.stats[newStat.name]=newStat;
    }

    loadStats(filename)
    {
        try 
        {
          if (fs.existsSync(filename)) // Check if file exists
          {
            const rawData = fs.readFileSync(filename); // Read data synchronously
            const data = JSON.parse(rawData); // Parse and load data
            Object.keys(this.stats).forEach(k => { if (data[k] != undefined) this.stats[k].load(data[k]); });
            this.loaded = true;
          }
        } catch (error) 
        {
          console.error('Failed to load stats:', error);
        }
    }

    saveStats(filename) 
    {
        let data = {};
        Object.keys(this.stats).forEach(k => { data[k]=this.stats[k].save(); });
        try 
        {
          fs.writeFileSync(filename, JSON.stringify(data)); // Save data synchronously
          //console.log('Data saved successfully.');
        } catch (error) 
        {
          console.error('Failed to save stats:', error);
        }
    }

    statsCounterInc(counter,subtype='',increment=1)
    {
        if (this.stats[counter]!=undefined)
        {
            this.stats[counter].increment(subtype,increment);
        }
    }


    async requestMetrics(req, res,metrics)
    {
        //metrics=await this.constructor.generateMetrics(metrics);
        metrics=await this.generateMetrics(metrics);

        return res.status(200).send(metrics); 
    }


    async generateMetrics(metrics)
    {
        Object.keys(this.stats).forEach(k => metrics+=this.stats[k].generateMetrics());
        return (metrics);
    }


    
    
}


export {StatsCounter,StatsSpooler}

