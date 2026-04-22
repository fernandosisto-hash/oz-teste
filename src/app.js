const express = require('express');
const routes = require('./routes');

const app = express();

app.use(express.json());

// Mount API routes
app.use('/', routes);

module.exports = app;
