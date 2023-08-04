import Fastify from 'fastify';
import axios from 'axios';
import oleoo from 'oleoo';
import { default as tnp } from 'torrent-name-parser';
import stringSimilarity from 'string-similarity';
import crypto from 'crypto';
import JSONdb from 'simple-json-db';
import path from 'path'

const APP_ROOT = path.dirname(process.argv[1])

const fastify = Fastify({ logger: false });


const db = new JSONdb(`${APP_ROOT}/imdb.json`);

tnp.configure({year: /[0-9]{4}/});

const THEMOVIEDB_API = process.env.THEMOVIEDB_API || '';
const PORT = process.env.PORT || 9090;

function cleanInput(input) {
    return input.trim()
    .replaceAll(/[0-9]{3,}x[0-9]{3,}/g, ' ')
    .replaceAll('-', ' ')
    .replaceAll(':', '')
    .toLowerCase()
}

function percentage(x, a, b) {
    return (x - a) / (b - a)
}

const differenceBetweenDates = (date1, date2) => {
    const tsDifference = date1.getTime() - date2.getTime();
    return Math.floor(tsDifference / (1000 * 60 * 60 * 24));
};

async function findImdbForInput(body, full = false) {
    try {
        let outputArr = []
        for (let raw of body) {
            
            let modifiedInput = ''
            let parsedData = {}
            
            // type can be `series` or `movie`
            // when it's `series` then a `season: number` and `episode: number` will exist too.
            let output = {imdbid: '', type: '', season: null, episode: null, inputhash: crypto.createHash('md5').update(raw).digest('hex')}

            // We'll likely receive files like "/bla/bla.mkv". Just gamble on taking the last part and roll with it.
            for (let input of raw.split('/').reverse()) {
                input = cleanInput(input); // stringSimilarity really doesn't like dashes.
                parsedData = tnp(input)

                // Season check
                if (parsedData?.season) {
                    output.season = parseInt(parsedData?.season)
                    input = parsedData.title
                }
        
                // Episode check
                if (parsedData?.episode) {
                    output.episode = parseInt(parsedData?.episode)
                }
        
                // Movie check
                if (!output.season && !output.episode) {
                    // We have something but it's likely for a movie.. tnp isn't good for movies, oleo is. Try it instead.
                    parsedData = oleoo.parse(input)
                    if (parsedData?.title) {
                        input = parsedData.title
                    }
                }
                
                // Remove dots in title
                input = input.replaceAll('.', ' ').trim()

                let longestConsequtiveSpaces = 0;
                let currentRange = 0;

                for (let chr of input) {
                    if (chr == ` `) {
                        currentRange++;
                    } else {
                        if (currentRange > longestConsequtiveSpaces) {
                            longestConsequtiveSpaces = currentRange;
                        }
                        currentRange = 0;
                    }
                }

                // Some multiple spaces magic going on. Likely some release group that prefixed the release with their name followed by a couple spaces. Or a typo.
                // TODO: We should run the search over each entry here.
                // We just take the last entry and call it "done" for simplicity, but we could be missing the intended title here
                if (longestConsequtiveSpaces > 1) {
                    let split = input.split(' '.repeat(longestConsequtiveSpaces))
                    console.log(`Multiple consequtive spaces detected! Using the last entry.`)
                    console.table(split)
                    input = split.pop()
                }
                
                if (parsedData?.year || parsedData?.encoding || parsedData?.codec) {
                    // Lowercase all of it
                    modifiedInput = input.toLowerCase()
                    break;
                }
            }
            
            if (modifiedInput == null || modifiedInput.length < 2) {
                output.error = `Unable to parse input.`
                outputArr.push({inputhash: output.inputhash, error: output.error})
                continue;
            }
            
            // Get potentially matching results from the movie db
            let media = (parsedData?.episode != null) ? "tv" : "multi"
            let searchResponse = await axios.get(`https://api.themoviedb.org/3/search/${media}?api_key=${THEMOVIEDB_API}&language=en-US&query=${encodeURIComponent(modifiedInput)}&page=1&include_adult=true`);
            let results = searchResponse.data.results.filter(obj => obj.original_language == "en")

            console.log(`https://api.themoviedb.org/3/search/${media}?api_key=${THEMOVIEDB_API}&language=en-US&query=${encodeURIComponent(modifiedInput)}&page=1&include_adult=true`)

            // Add a string similarity rating to each result. This is a percentage that indicates how closely an entry matches our input string
            results = results.map(obj => ({ ...obj, similarity: stringSimilarity.compareTwoStrings(modifiedInput, (obj?.title) ? obj.title.toLowerCase() : obj.name.toLowerCase()) }))
            
            // Sort based on that rating
            results.sort((a, b) => { return a.id - b.id })

            // If we have a year, update all results with a +0.2 similarity if the release_date includes our input.
            if (parsedData?.year?.length == 4) {
                results = results.map(obj => ({ ...obj, similarity: obj.similarity += (obj?.release_date?.includes(parsedData.year)) ? 0.2 : 0.0 }))
            }
    
            if (results.length > 0) {
                let bestMatch = results.reduce((prev, current) => (prev.similarity > current.similarity) ? prev : current)
                let countBestMatches = results.reduce((acc, cur) => cur.similarity === bestMatch.similarity ? ++acc : acc, 0)
                if (countBestMatches > 1) {
                    // Damn! We have multiple entries with equal similarity.
                    // Add in the popularity (0.1 as extra value. Added proportionally to all those matches.)
                    let equalBestMatches = results.filter((obj) => obj.similarity === bestMatch.similarity)
                    let maxPopularity = Math.max(...equalBestMatches.map(o => o.popularity), 0);
                    let minPopularity = Math.min(...equalBestMatches.map(o => o.popularity), 0);
    
                    for(let obj of equalBestMatches) {
                        obj.similarity += percentage(obj.popularity, minPopularity, maxPopularity) / 100
                    }
    
                    // Update what the best match is.
                    bestMatch = equalBestMatches.reduce((prev, current) => (prev.similarity > current.similarity) ? prev : current)
                }
    
                let title = (bestMatch?.title) ? bestMatch.title : bestMatch.name
    
                // If the match is less then 0.7, disgard it.
                if (bestMatch.similarity < 0.7) {
                    output.error = `We had a match but the similarity score of ${bestMatch.similarity} (${title}) is below our threshold of 0.7 so we ignored it.`
                    outputArr.push({inputhash: output.inputhash, error: output.error})
                    continue;
                }
    
                let media_type = (media == "tv") ? "tv" : "movie"

                if (bestMatch?.media_type) {
                    media_type = bestMatch.media_type
                }
    
                let externalIdResponse = await axios.get(`https://api.themoviedb.org/3/${media_type}/${bestMatch.id}/external_ids?api_key=${THEMOVIEDB_API}&language=en-US`);
                
                if (externalIdResponse.data?.imdb_id?.length < 5) {
                    output.error = `The found series/movie doesn't have an IMDB ID in this API.`
                    outputArr.push({inputhash: output.inputhash, error: output.error})
                    continue;
                }
    
                output.imdbid = externalIdResponse.data.imdb_id
                output.type = (media == "tv") ? "series" : "movie"
                
                if (full) {
                    output.full = bestMatch
                }
    
                // Remove season and episode from output if we had a movie
                if (output.type == `movie`) {
                    delete output.season;
                    delete output.episode;
                }
            }

            outputArr.push(output)
        }

        return outputArr
    } catch (error) {
        console.log(error)
        return {error: error.message}
    }
}

async function imdbBlob(imdbid) {
    let hasImdbid = db.has(imdbid)
    if (!hasImdbid) {
        try {
            console.log(`Fetching IMDB data for ${imdbid}`)
            let imdbResponse = await axios.get(`https://api.themoviedb.org/3/find/${imdbid}?api_key=${THEMOVIEDB_API}&language=en-US&external_source=imdb_id`);

            let results = null
    
            if (imdbResponse?.data?.tv_results?.length > 0) {
                results = imdbResponse.data.tv_results[0]
                results.title = results.name
            } else {
                results = imdbResponse.data.movie_results[0]
            }
            
            db.set(imdbid, results)
        } catch (error) {
            console.log(error)
            throw new Error(error);
        }
    }

    return {cached: hasImdbid, imdb: db.get(imdbid)}
}

async function episodeDetails(imdb, season, episode) {
    try {
        let imdbData = await imdbBlob(imdb);
        let id = imdbData?.imdb?.id;
        let imdbSeasonTag = `${imdb}_${season}`
        let hasImdbSeasonTag = db.has(imdbSeasonTag)
        let seasonData = null;

        if (imdbData?.imdb?.media_type != "tv") {
            throw new Error(`Requested imdb ${imdb} is not a tv series.`);
        }

        if (id == undefined) {
            throw new Error(`ID was undefined ${id}.`);
        }


        // TODO: This logic always refreshes episode data after a week.
        // That is fine for airing series, but series (and seasons) that have completely aired probably won't change.
        // Make this logic smarter to figure out if a season has aired (then keep it in cache). If it hasn't 
        // completely airled yet then refresh every week.

        // check the cache data of this season. We'll refresh it if it's over a week old.
        if (hasImdbSeasonTag) {
            seasonData = db.get(imdbSeasonTag);

            // Assume the data is wrong, this causes it to be reloaded.
            hasImdbSeasonTag = false;
            
            // UNLESS we have a cache date in the data and that date is within the past 7 days, then keep it as-is
            if (seasonData?.cacheddate) {
                let cacheddate = new Date(seasonData.cacheddate);

                // We're within a week, the cache is still "good enough".
                if (differenceBetweenDates(new Date(), cacheddate) < 7) {
                    hasImdbSeasonTag = true;
                }
            }
        }

        // Load data and cache it.
        if (!hasImdbSeasonTag) {
            let response = await axios.get(`https://api.themoviedb.org/3/tv/${id}/season/${season}?api_key=${THEMOVIEDB_API}&language=en-US`);
            response.data.cacheddate = new Date().toISOString()
            db.set(imdbSeasonTag, response.data)
        }

        let data = db.get(imdbSeasonTag);
        let episodeData = data.episodes.find(item => item.episode_number == episode);
        let returnBlob = {
            name: episodeData.name,
            description: episodeData.overview,
            runtime: episodeData.runtime,
            image: episodeData.still_path,
            
        }
        return {cached: true, episode: returnBlob}

    } catch (error) {
        console.log(error)
        throw new Error(error);
    }
}

// Silince the darn favicon
fastify.get('/favicon.ico', async (request, reply) => {
    return {}
})

fastify.get('/imdb/:imdbid', async (request, reply) => {
    const { imdbid } = request.params;
    let data = await imdbBlob(imdbid)
    return data.imdb;
})

fastify.get('/imdb/:imdbid/:season/:episode', async (request, reply) => {
    const { imdbid, season, episode } = request.params;
    let data = await episodeDetails(imdbid, season, episode)
    return data.episode;
})

fastify.post('/', async (request, reply) => {
    if (THEMOVIEDB_API.length < 10) {
        console.error(`You forget to start with THEMOVIEDB_API defined.`)
    }
    
    return findImdbForInput(request.body, false)
})

fastify.post('/full', async (request, reply) => {
    if (THEMOVIEDB_API.length < 10) {
        console.error(`You forget to start with THEMOVIEDB_API defined.`)
    }
    
    return findImdbForInput(request.body, true)
})

// Run the server!
const start = async () => {
    try {
        console.log(`DLName to IMDB ID on port ${PORT}`)
        fastify.listen({port: PORT, host: '0.0.0.0'})
    } catch (err) {
        console.log(err)
        process.exit(1)
    }
}
start()
