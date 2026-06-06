// 4K UHD Blu-ray Collection Data
// Fresh Database Seed File

const movieData = {
  "categories": [
    {
      "id": "cat_begin_here",
      "name": "Begin Here!",
      "entries": [
        {
          "id": "seed_entry_01",
          "title": "Welcome! Delete or edit this entry to start your collection.",
          "year": 2026,
          "format": "4k",
          "owned": true,
          "digitized": false,
          "isBoxSet": false,
          "links": {
            "amazon": "",
            "bestbuy": ""
          }
        }
      ]
    }
  ]
};

if (typeof module !== 'undefined') module.exports = movieData;