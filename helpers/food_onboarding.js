// Food onboarding question config - exact texts approved
const FOOD_ONBOARDING = {
  START: {
    text: "NYC Scout here 🗽 Want personalized food recs? 5 quick questions (20 sec).",
    replies: [
      { title: "Personalize ✅", payload: "FOOD_ONBOARD_START" },
      { title: "Skip", payload: "FOOD_ONBOARD_SKIP" }
    ]
  },

  Q1: {
    text: "Any dietary needs or hard no's?",
    replies: [
      { title: "Vegetarian 🥗", payload: "DIET_VEGETARIAN" },
      { title: "Vegan 🌱", payload: "DIET_VEGAN" },
      { title: "Halal ☪️", payload: "DIET_HALAL" },
      { title: "Kosher ✡️", payload: "DIET_KOSHER" },
      { title: "No pork 🚫🐷", payload: "DIET_NOPORK" },
      { title: "Gluten-free 🌾", payload: "DIET_GLU_FREE" },
      { title: "Nut allergy 🥜", payload: "DIET_NUT" },
      { title: "No restrictions ✅", payload: "DIET_NONE" }
    ]
  },

  Q2: {
    text: "What's your usual budget?",
    replies: [
      { title: "Cheap ($) 💸", payload: "BUDGET_$" },
      { title: "Mid ($$) 🙂", payload: "BUDGET_$$" },
      { title: "Nice ($$$) ✨", payload: "BUDGET_$$$" },
      { title: "Any 🤷", payload: "BUDGET_ANY" }
    ]
  },

  Q3: {
    text: "Where do you usually want food?",
    replies: [
      { title: "Manhattan 🏙", payload: "BOROUGH_MANHATTAN" },
      { title: "Brooklyn 🌉", payload: "BOROUGH_BROOKLYN" },
      { title: "Queens 🚇", payload: "BOROUGH_QUEENS" },
      { title: "Bronx 🏢", payload: "BOROUGH_BRONX" },
      { title: "Staten Island 🗽", payload: "BOROUGH_STATEN" },
      { title: "Anywhere 🌍", payload: "BOROUGH_ANY" }
    ]
  },

  Q4: {
    text: "What are you usually craving?",
    replies: [
      { title: "Asian 🍜", payload: "CRAVE_ASIAN" },
      { title: "Italian / Pizza 🍕", payload: "CRAVE_ITALIAN" },
      { title: "Mexican 🌮", payload: "CRAVE_MEXICAN" },
      { title: "American / Comfort 🍔", payload: "CRAVE_AMERICAN" },
      { title: "Middle Eastern 🥙", payload: "CRAVE_MIDEAST" },
      { title: "Indian 🍲", payload: "CRAVE_INDIAN" },
      { title: "Cafes / Dessert 🍰", payload: "CRAVE_CAFE" }
    ]
  },

  Q5: {
    text: 'Drop 1–2 NYC places you already love (or type "skip").'
  },

  DONE: {
    text: "Perfect — I got you 🍽️\nTell me what you're looking for right now (ex: \"cheap dinner in brooklyn\" / \"best ramen\" / \"halal spots\")."
  }
};

module.exports = { FOOD_ONBOARDING };