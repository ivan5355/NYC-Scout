const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'user_limits.json');

const LIMITS = {
    GEMINI_REQUESTS: 20,
    WEB_SEARCHES: 4
};

function loadData() {
    if (!fs.existsSync(DATA_FILE)) {
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (err) {
        console.error('Error loading rate limit data:', err);
        return {};
    }
}

function saveData(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Error saving rate limit data:', err);
    }
}

function getTodayKey() {
    return new Date().toISOString().split('T')[0];
}

function checkAndIncrementGemini(userId) {
    const data = loadData();
    const today = getTodayKey();

    if (!data[userId]) {
        data[userId] = { date: today, gemini: 0, search: 0 };
    }

    if (data[userId].date !== today) {
        data[userId] = { date: today, gemini: 0, search: 0 };
    }

    if (data[userId].gemini >= LIMITS.GEMINI_REQUESTS) {
        return false;
    }

    data[userId].gemini += 1;
    saveData(data);
    console.log(`User ${userId} Gemini usage: ${data[userId].gemini}/${LIMITS.GEMINI_REQUESTS}`);
    return true;
}

function checkAndIncrementSearch(userId) {
    const data = loadData();
    const today = getTodayKey();

    if (!data[userId]) {
        data[userId] = { date: today, gemini: 0, search: 0 };
    }

    if (data[userId].date !== today) {
        data[userId] = { date: today, gemini: 0, search: 0 };
    }

    if (data[userId].search >= LIMITS.WEB_SEARCHES) {
        return false;
    }

    data[userId].search += 1;
    saveData(data);
    console.log(`User ${userId} Web Search usage: ${data[userId].search}/${LIMITS.WEB_SEARCHES}`);
    return true;
}

module.exports = {
    checkAndIncrementGemini,
    checkAndIncrementSearch
};
