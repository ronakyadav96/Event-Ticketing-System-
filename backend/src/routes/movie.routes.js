const express = require('express');
const movieController = require('../controllers/movie.controller');

const router = express.Router();

router.get('/', movieController.listMovies);
router.get('/search', movieController.searchMovies);
router.get('/recommendations', movieController.getRecommendations);
// Proxy OMDb/TMDB poster lookup — API key stays on the server, results cached 24h
router.get('/poster', movieController.getPoster);
router.get('/omdb', movieController.getOmdbDetails);
router.get('/:movieId', movieController.getMovieById);

module.exports = router;
