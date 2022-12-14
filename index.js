const fastify = require('fastify')({ logger: false })
const axios = require('axios');
const fs = require('fs');
const oleoo = require('oleoo')
const tnp = require('torrent-name-parser')
const stringSimilarity = require('string-similarity')
const crypto = require('crypto');

const THEMOVIEDB_API = process.env.THEMOVIEDB_API || '';
const PORT = process.env.PORT || 9090;

function cleanInput(input) {
    return input.trim()
    .replaceAll('-', ' ')
    .replaceAll(':', '')
    .toLowerCase()
}

function percentage(x, a, b) {
    return (x - a) / (b - a)
}

// Silince the darn favicon
fastify.get('/favicon.ico', async (request, reply) => {
    return {}
})

fastify.post('/', async (request, reply) => {
    if (THEMOVIEDB_API.length < 10) {
        console.error(`You forget to start with THEMOVIEDB_API defined.`)
    }

    try {
        let outputArr = []
        for (let raw of request.body) {

            // We'll likely receive files like "/bla/bla.mkv". Just gamble on taking the last part and roll with it.
            let input = raw.split('/').pop()

            // type can be `series` or `movie`
            // when it's `series` then a `season: number` and `episode: number` will exist too.
            let output = {imdbid: '', type: '', season: null, episode: null, inputhash: crypto.createHash('md5').update(raw).digest('hex')}

            let modifiedInput = input
            modifiedInput = cleanInput(modifiedInput); // stringSimilarity really doesn't like dashes.
            let parsedData = tnp(modifiedInput)

            // Season check
            if (parsedData?.season) {
                output.season = parseInt(parsedData?.season)
                modifiedInput = parsedData.title
            }
    
            // Episode check
            if (parsedData?.episode) {
                output.episode = parseInt(parsedData?.episode)
            }
    
            // Movie check
            if (!output.season && !output.episode) {
                // We have something but it's likely for a movie.. tnp isn't good for movies, oleo is. Try it instead.
                parsedData = oleoo.parse(modifiedInput)
                if (parsedData?.title) {
                    modifiedInput = parsedData.title
                }
            }
            
            // Remove dots in title
            modifiedInput = modifiedInput.replaceAll('.', ' ').trim()

            let longestConsequtiveSpaces = 0;
            let currentRange = 0;

            for (let chr of modifiedInput) {
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
            // We just take the last entry and call it "done" for simplicity, but we could be missing the inended title here
            if (longestConsequtiveSpaces > 1) {
                let split = modifiedInput.split(' '.repeat(longestConsequtiveSpaces))
                console.log(`Multiple consequtive spaces detected! Using the last entry.`)
                console.table(split)
                modifiedInput = split.pop()
            }

            // Lowercase all of it
            modifiedInput = modifiedInput.toLowerCase()
            
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
    
                type = (media_type == "tv") ? "tvshow" : "movie"
    
                let externalIdResponse = await axios.get(`https://api.themoviedb.org/3/${media_type}/${bestMatch.id}/external_ids?api_key=${THEMOVIEDB_API}&language=en-US`);
                
                if (externalIdResponse.data?.imdb_id?.length < 5) {
                    output.error = `The found series/movie doesn't have an IMDB ID in this API.`
                    outputArr.push({inputhash: output.inputhash, error: output.error})
                    continue;
                }
    
                output.imdbid = externalIdResponse.data.imdb_id
                output.type = (media == "tv") ? "series" : "movie"
    
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
        return {error: error.message}
    }
})

// Run the server!
const start = async () => {
    try {
        console.log(THEMOVIEDB_API)
        console.log(`DLName to IMDB ID on port ${PORT}`)
        fastify.listen({port: PORT, host: '0.0.0.0'})
    } catch (err) {
        console.log(err)
        process.exit(1)
    }
}
start()
