import Fastify from "fastify";
import axios from "axios";
import oleoo from "oleoo";
import { default as tnp } from "torrent-name-parser";
import stringSimilarity from "string-similarity";
import crypto from "crypto";
import JSONdb from "simple-json-db";
import path from "path";
import { QdrantClient } from "@qdrant/js-client-rest";
import { getLlama } from "node-llama-cpp";

const APP_ROOT = path.dirname(process.argv[1]);

const fastify = Fastify({ logger: false });

const llama = await getLlama({ gpu: false });
const model = await llama.loadModel({
  modelPath: path.join(APP_ROOT, "models", "all-MiniLM-L6-v2-ggml-model-f16.gguf"),
});

const QDRANT_HOST = process.env.QDRANT_HOST || "";
const embeddingContext = await model.createEmbeddingContext();
let qdrclient = null;

const db = new JSONdb(`${APP_ROOT}/imdb.json`);

const THEMOVIEDB_API = process.env.THEMOVIEDB_API || "";
const PORT = process.env.PORT || 9090;

function cleanInput(input) {
  return input
    .trim()
    .replaceAll(/[0-9]{3,}x[0-9]{3,}/g, " ")
    .replaceAll(/\d{5,}/g, " ")
    .replaceAll("-", " ")
    .replaceAll(":", "")
    .replaceAll(/\s+/g, " ") // replace n-spaces with just 1. `foo   bar  baz` becomes `foo bar baz`
    .trim()
    .toLowerCase();
}

function percentage(x, min, max) {
  if (min === max) {
    return x <= min ? 0.0 : 1.0; // Edge case: Avoid division by zero
  }

  // Calculate interpolation (works for ascending/descending ranges)
  const interpolated = (x - min) / (max - min);

  // Clamp between 0.0 and 1.0
  return Math.min(1.0, Math.max(0.0, interpolated));
}

const differenceBetweenDates = (date1, date2) => {
  const tsDifference = date1.getTime() - date2.getTime();
  return Math.floor(tsDifference / (1000 * 60 * 60 * 24));
};

async function getEmbeddings(title) {
  // This does:
  // - Get rid of special characters
  // - Removes double spaces and replaces it with a single
  // - trim to get rid of whitespace at the start and end
  // - lowercase
  const cleanTitle = title
    .replace(/[^a-zA-Z0-9]/g, " ")
    .replace(/\d{5,}/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  // Get an array of words
  // const words = cleanTitle.split(" ");

  // let embeddings = await Promise.all(words.map(async (word) => (await embeddingContext.getEmbeddingFor(word)).vector));
  // embeddings.push((await embeddingContext.getEmbeddingFor(title)).vector);
  return (await embeddingContext.getEmbeddingFor(title)).vector;

  // Return an array of arrays with embeddings, filter out empty elements.
  // return embeddings.filter((subArray) => subArray.some(Boolean));
}

async function findImdbForInput(body, full = false) {
  try {
    let outputArr = [];
    for (let raw of body) {
      let modifiedInput = "";
      let parsedData = {};

      // type can be `series` or `movie`
      // when it's `series` then a `season: number` and `episode: number` will exist too.
      let output = { imdbid: "", type: "", season: null, episode: null, inputhash: crypto.createHash("md5").update(raw).digest("hex") };

      // We'll likely receive files like "/bla/bla.mkv". Just gamble on taking the last part and roll with it.
      for (const origInput of raw.split("/").reverse()) {
        let input = origInput;

        input = cleanInput(input); // stringSimilarity really doesn't like dashes.
        parsedData = tnp(input);

        // console.log(parsedData);

        // Season check
        if (parsedData?.season) {
          output.season = parseInt(parsedData?.season);
          input = parsedData.title;

          // If we have a season but no episode, just fill in a default episode number.
          // This likely is for queries where we have a S01 torrent, like a whole season.
          if (!parsedData?.episode) {
            parsedData.episode = 1;
          }
        }

        // Episode check
        if (parsedData?.episode) {
          output.episode = parseInt(parsedData?.episode);
        }

        const oneOfSeasonEpisode = (output.season == null && output.episode != null) || (output.episode == null && output.season != null);
        const probablyMovie = output.season != null && output.episode != null ? false : oneOfSeasonEpisode ? false : true;
        const hasYear = (parsedData?.year && parsedData?.year > 0) || false;

        // Movie check
        if ((oneOfSeasonEpisode && hasYear) || probablyMovie) {
          // We have something but it's likely for a movie.. tnp isn't good for movies, oleo is. Try it instead.
          parsedData = oleoo.parse(input);
          if (parsedData?.title) {
            input = parsedData.title;
          }
        }

        if (parsedData?.year || parsedData?.encoding || parsedData?.codec || parsedData?.season) {
          // Lowercase all of it
          modifiedInput = input.toLowerCase();
          break;
        }
      }

      if (modifiedInput == null || modifiedInput.length < 2) {
        output.error = `Unable to parse input.`;
        outputArr.push({ inputhash: output.inputhash, error: output.error });
        continue;
      }

      // Determine is we have a movie. If not then it's a series.
      let isExplicitMovie = parsedData?.type == "movie";
      let isExplicitSeries = !isExplicitMovie && (parsedData?.season != null || parsedData?.episode != null);

      // Get the year part if it's parsable, else just NaN
      let year = parseInt(parsedData?.year || NaN);

      // Filter on movie or series
      const mustFilter = [];

      if (isExplicitMovie) {
        mustFilter.push({ key: "type", match: { value: "m" } });
      } else if (isExplicitSeries) {
        mustFilter.push({ key: "type", match: { value: "s" } });
      }

      // If we have a year, we require the results to match that year
      if (!isNaN(year)) {
        mustFilter.push({ key: "year", match: { value: year } });
      }

      console.log(modifiedInput);
      console.log(mustFilter);
      console.log(parsedData);

      // Get the best possible matching results
      const embedding = await getEmbeddings(modifiedInput);
      const res = (
        await qdrclient.query("imdb", {
          query: embedding,
          with_payload: true,
          filter: {
            must: mustFilter,
          },
          params: {
            quantization: {
              ignore: false,
              rescore: true,
              oversampling: 2.0,
            },
          },
          limit: 50,
        })
      ).points;

      // const res = (
      //   await qdrclient.query("imdb", {
      //     prefetch: {
      //       query: embedding,
      //       filter: {
      //         must: mustFilter,
      //       },
      //       params: {
      //         quantization: {
      //           ignore: false,
      //           rescore: true,
      //           oversampling: 2.0,
      //         },
      //       },
      //       limit: 50,
      //     },
      //     query: {
      //       formula: {
      //         sum: [
      //           "$score",
      //           {
      //             mult: [0.25, { key: "has_runtime", match: { value: true } }],
      //           },
      //         ],
      //       },
      //     },
      //     with_payload: true,
      //   })
      // ).points;

      // console.dir(res);

      // Now add a string similarity score to the remaining candidates
      let remainingRes = res.map((obj) => ({ ...obj, similarity: stringSimilarity.compareTwoStrings(modifiedInput, obj.payload.title.toLowerCase()) }));

      // Rescore the score itself, grab the highest score and the lowest score and, calculate a `rescore` property that is between 0 and 1.
      let maxScore = Math.max(...remainingRes.map((obj) => obj.score));
      let minScore = Math.min(...remainingRes.map((obj) => obj.score));
      remainingRes = remainingRes.map((obj) => ({ ...obj, oldscore: obj.score, score: percentage(obj.score, minScore, maxScore) }));

      if (maxScore === minScore) {
        maxScore = 0;
      }

      // Now we WILL have results, just how embeddings work. They could be completely off garbage and they could be spot on.
      // They should be spot on if the thing we're looking for is in our database.
      // However, we can't rely on it. If the database is outdated we might get false positives.
      // So iterate over the results, we're only going to consider db scores above 0.5 and a similarity of above 0.7.
      remainingRes = remainingRes.filter((obj) => {
        return obj.score >= 0.6;
      });

      // console.dir(remainingRes);

      // Now rescore the `score` property based on the `similarity` property. Get a min and max similarity and calculate the percentage
      let minSimilarity = Math.min(...remainingRes.map((obj) => obj.similarity));
      const maxSimilarity = Math.max(...remainingRes.map((obj) => obj.similarity));

      // If our max similarity is low, empty remainingRes (0.5 is low enough)
      if (maxSimilarity < 0.5) {
        remainingRes = [];
      }

      // Count how many have the same similarity
      const countSameSimilarity = remainingRes.filter((obj) => obj.similarity === maxSimilarity).length;

      if (minSimilarity === maxSimilarity) {
        minSimilarity = 0;
      }

      // Take 0.2 from the similarity if there is a higher similarity AND if the current one has `has_runtime` set to false.
      remainingRes = remainingRes.map((obj) => {
        if (obj.payload.has_runtime === false) {
          if (obj.similarity < maxSimilarity) {
            obj.similarity -= 0.2;
          } else if (countSameSimilarity > 1) {
            obj.similarity -= 0.2;
          }
        }
        return obj;
      });

      remainingRes = remainingRes.map((obj) => ({ ...obj, score: percentage(obj.similarity, minSimilarity, maxSimilarity) }));

      remainingRes = remainingRes.filter((obj) => {
        // return obj.score >= 0.5 && obj.similarity >= 0.7;
        return obj.score >= 0.8;
      });

      // console.dir(remainingRes);

      // We can end up with 0 results here even though the original results might have well had the perfect match.
      // Do an axilirary check:
      if (remainingRes.length == 0) {
        // - explode the modifiedInput to a words array
        let wordArray = modifiedInput.split(" ");
        if (wordArray == [] && modifiedInput.length > 0) {
          wordArray = [modifiedInput];
        }

        // - Add a 0-initialized similarity property
        let tempRes = res.map((obj) => ({ ...obj, similarity: stringSimilarity.compareTwoStrings(modifiedInput, obj.payload.title.toLowerCase()) }));

        // - Filter out results with a score lower then 0.5
        tempRes = tempRes.filter((obj) => {
          return obj.score >= 0.6;
        });

        // - If we end up with 0 result here then it's just not a match we can find.
        if (tempRes.length == 0) {
          output.error = `Could't match, even with relaxing rules.`;
          outputArr.push({ inputhash: output.inputhash, error: output.error });
          continue;
        }

        // - Loop over the words. If any of the results has the whole word it gets a +0.3, nothing if no match.
        tempRes = tempRes.map((obj) => {
          let scoreAdjustment = 0;
          for (const word of wordArray) {
            const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // Escape special characters in the word
            if (new RegExp(`\\b${escapedWord}\\b`, "i").test(obj.payload.title.toLowerCase())) {
              scoreAdjustment += 0.1;
            } else {
              scoreAdjustment -= 0.2;
            }
          }

          obj.score += scoreAdjustment;

          return obj;
        });

        // console.log(tempRes);

        // - And now we do the normal filtering again.
        tempRes = tempRes.filter((obj) => {
          return obj.score >= 0.5 && obj.similarity >= 0.7;
        });

        // If we still have something left, use this as our new remainingRes object
        if (tempRes.length > 0) {
          remainingRes = tempRes;
        }
      }

      // console.table(parsedData);
      // console.dir(remainingRes);

      // Sort based on similarity
      remainingRes.sort((a, b) => {
        return b.similarity - a.similarity;
      });

      // console.dir(remainingRes);

      // Do we have items left?
      if (remainingRes.length > 1) {
        // Reduce it down to the equal highest matches (should be 1 but could be multiple).
        // Filter again but this time take the similarity of the first item and only keep others with an equal similarity
        remainingRes = remainingRes.filter((obj) => {
          return obj.similarity == remainingRes[0].similarity;
        });
      }

      // If we still have +1 items left, filter out by scory above 0.85.
      if (remainingRes.length > 1) {
        remainingRes = remainingRes.filter((obj) => {
          return obj.score > 0.85;
        });
      }

      // console.dir(remainingRes);

      // Do we STILL have +1 items left? Damn! Must be a series or movie with the same name over different years.
      // Take the newest year. Note that this is only possible when the search query didn't had a year (which is mostly for series a likely scenario).
      if (remainingRes.length > 1) {
        // Sort by year and remove all but the first one
        const maxYear = Math.max(...remainingRes.map((obj) => obj.payload.year));
        remainingRes = remainingRes.filter((obj) => obj.payload.year === maxYear);
      }

      // Technically.. We can still have 1+... This is only possible if there's a series or a movie by the same name and the same year.
      // Yeah, not gonna filter on that one. We could take the highest imdb id.. but not worth it.

      // If we have nothing left, continue.
      if (remainingRes.length == 0) {
        output.error = `The found series/movie doesn't have an IMDB ID in this API.`;
        outputArr.push({ inputhash: output.inputhash, error: output.error });
        continue;
      }

      // Oke, we have one. Take it's imdbid and reparse it. An imdbid must have 7 digits or more but leading zeoros are lost (as we ised it as index)
      // So we have to fix that.
      let tempImdbString = remainingRes[0].id.toString();
      const imdbid = `tt` + tempImdbString.padStart(7, "0");

      output.imdbid = imdbid;
      if (isExplicitMovie) {
        output.type = "movie";
      } else if (isExplicitSeries) {
        output.type = "series";
      } else {
        output.error = `There was a detection but no explicit movie or series. Parser bug!`;
        outputArr.push({ inputhash: output.inputhash, error: output.error });
        continue;
      }

      // Remove season and episode from output if we had a movie
      if (output.type == `movie`) {
        delete output.season;
        delete output.episode;
      }

      // We embed the IMDB data if the request had `/full`.
      if (full) {
        const imdbidData = await imdbBlob(imdbid);

        if (!imdbidData?.imdb?.media_type) {
          continue;
        }

        output.full = imdbidData.imdb;
      }

      outputArr.push(output);
    }

    console.log(`-------------`);
    console.log(body);
    console.log(outputArr);

    return outputArr;
  } catch (error) {
    console.log(error);
    return { error: error.message };
  }
}

async function imdbBlob(imdbid) {
  let hasImdbid = db.has(imdbid);
  if (!hasImdbid) {
    try {
      console.log(`Fetching IMDB data for ${imdbid}`);
      let imdbResponse = await axios.get(`https://api.themoviedb.org/3/find/${imdbid}?api_key=${THEMOVIEDB_API}&language=en-US&external_source=imdb_id`);

      let results = null;

      if (imdbResponse?.data?.tv_results?.length > 0) {
        results = imdbResponse.data.tv_results[0];
        results.title = results.name;
      } else {
        results = imdbResponse.data.movie_results[0];
      }

      db.set(imdbid, results);
    } catch (error) {
      console.log(error);
      throw new Error(error);
    }
  }

  return { cached: hasImdbid, imdb: db.get(imdbid) };
}

async function episodeDetails(imdb, season, episode) {
  try {
    let imdbData = await imdbBlob(imdb);
    let id = imdbData?.imdb?.id;
    let imdbSeasonTag = `${imdb}_${season}`;
    let hasImdbSeasonTag = db.has(imdbSeasonTag);
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
      response.data.cacheddate = new Date().toISOString();
      db.set(imdbSeasonTag, response.data);
    }

    let imdbdata = await imdbBlob(imdb);

    let data = db.get(imdbSeasonTag);
    let episodeData = data.episodes.find((item) => item.episode_number == episode);
    let returnBlob = {
      name: episodeData.name,
      description: episodeData.overview,
      runtime: episodeData.runtime,
      image: episodeData.still_path,
      backdrop: imdbdata.imdb.backdrop_path,
      seriesposter: imdbdata.imdb.poster_path,
      airdate: new Date(Date.UTC(...episodeData.air_date.split("-").map(Number))),
    };
    return { cached: true, episode: returnBlob };
  } catch (error) {
    console.log(error);
    throw new Error(error);
  }
}

// Silince the darn favicon
fastify.get("/favicon.ico", async (request, reply) => {
  return {};
});

fastify.get("/imdb/:imdbid", async (request, reply) => {
  const { imdbid } = request.params;
  let data = await imdbBlob(imdbid);
  return data.imdb;
});

fastify.get("/imdb/:imdbid/:season/:episode", async (request, reply) => {
  const { imdbid, season, episode } = request.params;
  let data = await episodeDetails(imdbid, season, episode);
  return data.episode;
});

fastify.post("/", async (request, reply) => {
  return findImdbForInput(request.body, false);
});

fastify.post("/full", async (request, reply) => {
  return findImdbForInput(request.body, true);
});

// Run the server!
const start = async () => {
  try {
    if (THEMOVIEDB_API.length < 10) {
      throw new Error(`You forget to start with THEMOVIEDB_API defined.`);
    }

    if (QDRANT_HOST.length < 5) {
      throw new Error(`You forget to start with QDRANT_HOST defined.`);
    }

    // init qdrant
    qdrclient = new QdrantClient({ host: QDRANT_HOST, port: 6333 });

    console.log(`DLName to IMDB ID on port ${PORT}`);
    fastify.listen({ port: PORT, host: "0.0.0.0" });
  } catch (err) {
    console.log(err);
    process.exit(1);
  }
};
start();
