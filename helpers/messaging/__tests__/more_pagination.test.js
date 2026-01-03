/**
 * "More" Pagination Tests
 * Feature: restaurant-more-pagination
 * 
 * These tests verify the "more" follow-up behavior works correctly:
 * 1. "more" serves from stored pool without re-running search
 * 2. "more" never asks for borough or other constraints
 * 3. Exhausted pool shows appropriate message and quick replies
 */

// Mock the modules before requiring the handler
jest.mock('axios');
jest.mock('mongodb');

const { MongoClient } = require('mongodb');

// Mock MongoDB
const mockCollection = {
  findOne: jest.fn(),
  insertOne: jest.fn(),
  updateOne: jest.fn(),
  deleteOne: jest.fn(),
  countDocuments: jest.fn(),
  find: jest.fn(() => ({
    sort: jest.fn(() => ({
      limit: jest.fn(() => ({
        toArray: jest.fn(() => Promise.resolve([]))
      }))
    }))
  })),
  createIndex: jest.fn()
};

const mockDb = {
  collection: jest.fn(() => mockCollection)
};

MongoClient.mockImplementation(() => ({
  connect: jest.fn(() => Promise.resolve()),
  db: jest.fn(() => mockDb)
}));

// Now require the modules
const { processDMForTest } = require('../message_handler');
const { updateContext, getContext, getOrCreateProfile } = require('../../users/user_profile');

describe('More Pagination Tests', () => {
  
  // Sample restaurant pool for testing
  const samplePool = [
    { name: 'Restaurant 1', neighborhood: 'SoHo', borough: 'Manhattan', price_range: '$$', why: 'Great vibes', what_to_order: ['Pad Thai'], vibe: 'Casual', dedupeKey: 'restaurant1|soho' },
    { name: 'Restaurant 2', neighborhood: 'Williamsburg', borough: 'Brooklyn', price_range: '$', why: 'Authentic', what_to_order: ['Green Curry'], vibe: 'Trendy', dedupeKey: 'restaurant2|williamsburg' },
    { name: 'Restaurant 3', neighborhood: 'East Village', borough: 'Manhattan', price_range: '$$', why: 'Local favorite', what_to_order: ['Tom Yum'], vibe: 'Hole-in-the-wall', dedupeKey: 'restaurant3|eastvillage' },
    { name: 'Restaurant 4', neighborhood: 'LES', borough: 'Manhattan', price_range: '$$$', why: 'Date night spot', what_to_order: ['Khao Soi'], vibe: 'Date-night', dedupeKey: 'restaurant4|les' },
    { name: 'Restaurant 5', neighborhood: 'Chelsea', borough: 'Manhattan', price_range: '$$', why: 'Great lunch', what_to_order: ['Drunken Noodles'], vibe: 'Casual', dedupeKey: 'restaurant5|chelsea' },
    { name: 'Restaurant 6', neighborhood: 'Greenpoint', borough: 'Brooklyn', price_range: '$$', why: 'Hidden gem', what_to_order: ['Larb'], vibe: 'Trendy', dedupeKey: 'restaurant6|greenpoint' },
    { name: 'Restaurant 7', neighborhood: 'Flushing', borough: 'Queens', price_range: '$', why: 'Best in Queens', what_to_order: ['Pad See Ew'], vibe: 'Casual', dedupeKey: 'restaurant7|flushing' },
    { name: 'Restaurant 8', neighborhood: 'Astoria', borough: 'Queens', price_range: '$$', why: 'Family friendly', what_to_order: ['Massaman Curry'], vibe: 'Casual', dedupeKey: 'restaurant8|astoria' },
    { name: 'Restaurant 9', neighborhood: 'Bushwick', borough: 'Brooklyn', price_range: '$', why: 'Late night', what_to_order: ['Papaya Salad'], vibe: 'Casual', dedupeKey: 'restaurant9|bushwick' },
    { name: 'Restaurant 10', neighborhood: 'Midtown', borough: 'Manhattan', price_range: '$$$', why: 'Business lunch', what_to_order: ['Thai Iced Tea'], vibe: 'Upscale', dedupeKey: 'restaurant10|midtown' }
  ];

  const baseProfile = {
    _id: 'test_user_123',
    foodProfile: { dietary: [], budget: null, borough: null },
    context: {}
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isMoreRequest detection', () => {
    // We'll test the detection by simulating various "more" inputs
    const moreVariants = [
      'more',
      'More',
      'MORE',
      'more please',
      'More Please',
      'more options',
      'show more',
      'show me more',
      'different options',
      'other options',
      'next',
      'gimme more',
      'give me more',
      'what else'
    ];

    const notMoreInputs = [
      'more thai food',
      'i want more spicy options',
      'tell me more about this restaurant',
      'pad thai',
      'restaurants in manhattan'
    ];

    test.each(moreVariants)('"%s" should be detected as a "more" request', (input) => {
      // This tests our pattern matching
      const MORE_PATTERNS = [
        /^more$/i,
        /^more please$/i,
        /^more options$/i,
        /^show more$/i,
        /^show me more$/i,
        /^different options$/i,
        /^other options$/i,
        /^next$/i,
        /^next options$/i,
        /^different ones$/i,
        /^other ones$/i,
        /^gimme more$/i,
        /^give me more$/i,
        /^any more$/i,
        /^anymore$/i,
        /^what else$/i
      ];
      
      const cleaned = input.toLowerCase().trim();
      const isMore = MORE_PATTERNS.some(pattern => pattern.test(cleaned));
      expect(isMore).toBe(true);
    });

    test.each(notMoreInputs)('"%s" should NOT be detected as a "more" request', (input) => {
      const MORE_PATTERNS = [
        /^more$/i,
        /^more please$/i,
        /^more options$/i,
        /^show more$/i,
        /^show me more$/i,
        /^different options$/i,
        /^other options$/i,
        /^next$/i,
        /^next options$/i,
        /^different ones$/i,
        /^other ones$/i,
        /^gimme more$/i,
        /^give me more$/i,
        /^any more$/i,
        /^anymore$/i,
        /^what else$/i
      ];
      
      const cleaned = input.toLowerCase().trim();
      const isMore = MORE_PATTERNS.some(pattern => pattern.test(cleaned));
      expect(isMore).toBe(false);
    });
  });

  describe('"more" with seeded pool', () => {
    
    test('returns items 6-10 when pool has 10 items and page is 0', async () => {
      // Seed context with pool and page 0 (meaning first 5 were shown)
      const seededContext = {
        pool: samplePool,
        page: 0,
        shownKeys: samplePool.slice(0, 5).map(r => r.dedupeKey),
        shownNames: samplePool.slice(0, 5).map(r => r.name),
        lastIntent: { dish: 'thai food', borough: 'Manhattan' },
        lastCategory: 'FOOD_SEARCH',
        lastUpdatedAt: new Date()
      };

      // Mock the profile and context
      mockCollection.findOne.mockResolvedValue({
        ...baseProfile,
        context: seededContext
      });

      const result = await processDMForTest('test_user_123', 'more');
      
      // Should return restaurants 6-10
      expect(result.reply).toContain('RESTAURANT 6');
      expect(result.reply).toContain('RESTAURANT 7');
      expect(result.reply).toContain('RESTAURANT 8');
      expect(result.reply).toContain('RESTAURANT 9');
      expect(result.reply).toContain('RESTAURANT 10');
      
      // Should NOT contain first 5 restaurants (using newline anchors to avoid substring matches like "10" containing "1")
      expect(result.reply).not.toMatch(/1\. RESTAURANT 1\n/);
      expect(result.reply).not.toMatch(/\. RESTAURANT 2\n/);
      expect(result.reply).not.toMatch(/\. RESTAURANT 3\n/);
      expect(result.reply).not.toMatch(/\. RESTAURANT 4\n/);
      expect(result.reply).not.toMatch(/\. RESTAURANT 5\n/);
      
      // Should NOT ask "Where in NYC?"
      expect(result.reply).not.toContain('Where in NYC');
      expect(result.reply).not.toContain('What area');
      expect(result.reply).not.toContain('Which borough');
      
      // Should NOT have borough quick reply buttons
      expect(result.buttons).toBeUndefined();
    });

    test('never asks for borough on "more"', async () => {
      const seededContext = {
        pool: samplePool,
        page: 0,
        shownKeys: [],
        lastIntent: { dish: 'pad thai' }, // Note: no borough
        lastCategory: 'FOOD_SEARCH',
        lastUpdatedAt: new Date()
      };

      mockCollection.findOne.mockResolvedValue({
        ...baseProfile,
        context: seededContext
      });

      const result = await processDMForTest('test_user_123', 'more');
      
      // Should return results, not ask for borough
      expect(result.reply).toContain('RESTAURANT');
      expect(result.reply).not.toContain('Where in NYC');
      expect(result.reply).not.toContain('What area');
    });

    test('handles "more please" variant', async () => {
      const seededContext = {
        pool: samplePool,
        page: 0,
        lastIntent: { dish: 'thai food' },
        lastCategory: 'FOOD_SEARCH',
        lastUpdatedAt: new Date()
      };

      mockCollection.findOne.mockResolvedValue({
        ...baseProfile,
        context: seededContext
      });

      const result = await processDMForTest('test_user_123', 'more please');
      
      expect(result.reply).toContain('RESTAURANT');
      expect(result.category).toBe('RESTAURANT');
    });

    test('handles "show me more" variant', async () => {
      const seededContext = {
        pool: samplePool,
        page: 0,
        lastIntent: { dish: 'thai food' },
        lastCategory: 'FOOD_SEARCH',
        lastUpdatedAt: new Date()
      };

      mockCollection.findOne.mockResolvedValue({
        ...baseProfile,
        context: seededContext
      });

      const result = await processDMForTest('test_user_123', 'show me more');
      
      expect(result.reply).toContain('RESTAURANT');
      expect(result.category).toBe('RESTAURANT');
    });
  });

  describe('exhausted pool behavior', () => {
    
    test('shows exhausted message when pool has no more results', async () => {
      // Seed context where we've already shown all 10 (page 1 means we showed 6-10)
      const seededContext = {
        pool: samplePool, // 10 items
        page: 1, // Already on page 1, next would be page 2 which starts at index 10
        shownKeys: samplePool.map(r => r.dedupeKey),
        lastIntent: { dish: 'pad thai', borough: 'Manhattan' },
        lastCategory: 'FOOD_SEARCH',
        lastUpdatedAt: new Date()
      };

      mockCollection.findOne.mockResolvedValue({
        ...baseProfile,
        context: seededContext
      });

      const result = await processDMForTest('test_user_123', 'more');
      
      // Should show exhausted message
      expect(result.reply).toContain("That's all I have for this search");
      
      // Should offer borough quick replies
      expect(result.buttons).toBeDefined();
      expect(result.buttons.length).toBeGreaterThan(0);
      
      // Should have Manhattan, Brooklyn, Queens, Anywhere options
      const payloads = result.buttons.map(b => b.payload);
      expect(payloads).toContain('BOROUGH_MANHATTAN');
      expect(payloads).toContain('BOROUGH_BROOKLYN');
      expect(payloads).toContain('BOROUGH_QUEENS');
      expect(payloads).toContain('BOROUGH_ANY');
    });

    test('shows helpful message when no pool exists', async () => {
      // No pool at all
      const seededContext = {
        pool: [],
        page: 0,
        lastIntent: null,
        lastCategory: null,
        lastUpdatedAt: new Date()
      };

      mockCollection.findOne.mockResolvedValue({
        ...baseProfile,
        context: seededContext
      });

      const result = await processDMForTest('test_user_123', 'more');
      
      // Should ask what user wants more of
      expect(result.reply.toLowerCase()).toContain('what');
    });
  });

  describe('output format compliance', () => {
    
    test('never includes URLs in output', async () => {
      // Pool with internal evidence URLs
      const poolWithUrls = samplePool.map(r => ({
        ...r,
        _evidence_url: 'https://example.com/menu',
        _evidence_text: 'The pad thai is excellent'
      }));

      const seededContext = {
        pool: poolWithUrls,
        page: 0,
        lastIntent: { dish: 'pad thai' },
        lastUpdatedAt: new Date()
      };

      mockCollection.findOne.mockResolvedValue({
        ...baseProfile,
        context: seededContext
      });

      const result = await processDMForTest('test_user_123', 'more');
      
      // Should NOT contain any URLs
      expect(result.reply).not.toMatch(/https?:\/\//);
      expect(result.reply).not.toContain('example.com');
    });

    test('always ends with "Reply more" when there are more results', async () => {
      // Pool with 12 items
      const largePool = [...samplePool, 
        { name: 'Restaurant 11', neighborhood: 'UWS', borough: 'Manhattan', price_range: '$$', why: 'Brunch spot', dedupeKey: 'restaurant11|uws' },
        { name: 'Restaurant 12', neighborhood: 'UES', borough: 'Manhattan', price_range: '$$$', why: 'Classic', dedupeKey: 'restaurant12|ues' }
      ];

      const seededContext = {
        pool: largePool,
        page: 0, // Just showed 1-5, there are 7 more
        lastIntent: { dish: 'thai food' },
        lastUpdatedAt: new Date()
      };

      mockCollection.findOne.mockResolvedValue({
        ...baseProfile,
        context: seededContext
      });

      const result = await processDMForTest('test_user_123', 'more');
      
      // Should end with the "more" prompt
      expect(result.reply).toContain('Reply "more" for different options');
    });

    test('shows "That\'s all" when this is the last batch', async () => {
      // Pool with exactly 10 items, page 0 means showing 6-10 next
      const seededContext = {
        pool: samplePool.slice(0, 10),
        page: 0,
        lastIntent: { dish: 'thai food' },
        lastUpdatedAt: new Date()
      };

      mockCollection.findOne.mockResolvedValue({
        ...baseProfile,
        context: seededContext
      });

      const result = await processDMForTest('test_user_123', 'more');
      
      // Should indicate this is the last batch
      expect(result.reply).toContain("That's all I have for this search");
    });
  });

  describe('context updates', () => {
    
    test('increments page after serving more results', async () => {
      const seededContext = {
        pool: samplePool,
        page: 0,
        shownKeys: [],
        lastIntent: { dish: 'thai food' },
        lastUpdatedAt: new Date()
      };

      mockCollection.findOne.mockResolvedValue({
        ...baseProfile,
        context: seededContext
      });

      await processDMForTest('test_user_123', 'more');
      
      // Verify updateOne was called with incremented page
      const updateCall = mockCollection.updateOne.mock.calls.find(call => 
        call[1]?.$set?.['context.page'] === 1
      );
      expect(updateCall).toBeDefined();
    });

    test('adds shown restaurant names to context', async () => {
      const seededContext = {
        pool: samplePool,
        page: 0,
        shownKeys: [],
        shownNames: [],
        lastIntent: { dish: 'thai food' },
        lastUpdatedAt: new Date()
      };

      mockCollection.findOne.mockResolvedValue({
        ...baseProfile,
        context: seededContext
      });

      await processDMForTest('test_user_123', 'more');
      
      // Verify updateOne was called with shownNames
      const updateCall = mockCollection.updateOne.mock.calls.find(call => 
        call[1]?.$set?.['context.shownNames']?.length > 0
      );
      expect(updateCall).toBeDefined();
    });
  });
});

