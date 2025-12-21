const axios = require('axios');
const fs = require('fs');
const path = require('path');

const NYC_PERMITTED_EVENTS_URL = 'https://data.cityofnewyork.us/resource/tvpp-9vvx.json';
const NYC_PARKS_EVENTS_URL = 'https://www.nycgovparks.org/xml/events_300_rss.json';

async function extractEventFilters() {
    try {
        console.log('Fetching NYC Permitted Events...');
        const permittedResponse = await axios.get(NYC_PERMITTED_EVENTS_URL);
        const permittedData = permittedResponse.data;

        console.log('Fetching NYC Parks Events...');
        const parksResponse = await axios.get(NYC_PARKS_EVENTS_URL);
        const parksData = parksResponse.data;

        const filters = {
            permitted_events: {
                event_type: new Set(),
                event_borough: new Set(),
                event_agency: new Set(),
                street_closure_type: new Set(),
                community_board: new Set(),
                police_precinct: new Set()
            },
            parks_events: {
                categories: new Set(),
                parknames: new Set()
            }
        };

        // Extract Permitted Events Filters
        permittedData.forEach(event => {
            if (event.event_type) filters.permitted_events.event_type.add(event.event_type.trim());
            if (event.event_borough) filters.permitted_events.event_borough.add(event.event_borough.trim());
            if (event.event_agency) filters.permitted_events.event_agency.add(event.event_agency.trim());
            if (event.street_closure_type) filters.permitted_events.street_closure_type.add(event.street_closure_type.trim());

            if (event.community_board) {
                event.community_board.split(',').forEach(cb => {
                    const val = cb.trim();
                    if (val) filters.permitted_events.community_board.add(val);
                });
            }
            if (event.police_precinct) {
                event.police_precinct.split(',').forEach(pp => {
                    const val = pp.trim();
                    if (val) filters.permitted_events.police_precinct.add(val);
                });
            }
        });

        // Extract Parks Events Filters
        parksData.forEach(event => {
            if (event.categories) {
                // Categories can be separated by | or ,
                const separators = /[|,]/;
                event.categories.split(separators).forEach(cat => {
                    const val = cat.trim();
                    if (val) filters.parks_events.categories.add(val);
                });
            }
            if (event.parknames) {
                const val = event.parknames.trim();
                if (val) filters.parks_events.parknames.add(val);
            }
        });

        // Convert Sets to sorted Arrays
        const result = {
            permitted_events: {
                event_type: Array.from(filters.permitted_events.event_type).sort(),
                event_borough: Array.from(filters.permitted_events.event_borough).sort(),
                event_agency: Array.from(filters.permitted_events.event_agency).sort(),
                street_closure_type: Array.from(filters.permitted_events.street_closure_type).sort(),
                community_board: Array.from(filters.permitted_events.community_board).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
                police_precinct: Array.from(filters.permitted_events.police_precinct).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            },
            parks_events: {
                categories: Array.from(filters.parks_events.categories).sort(),
                parknames: Array.from(filters.parks_events.parknames).sort()
            }
        };

        const outputPath = path.join(__dirname, '..', 'data', 'event_filters.json');
        const dataDir = path.join(__dirname, '..', 'data');

        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
        console.log(`Filters successfully extracted and saved to: ${outputPath}`);

    } catch (error) {
        console.error('Error extracting event filters:', error.message);
    }
}

if (require.main === module) {
    extractEventFilters();
}

module.exports = { extractEventFilters };
