const fetch = require('node-fetch');
global.Request = fetch.Request;
global.Headers = fetch.Headers;
global.Response = fetch.Response;
