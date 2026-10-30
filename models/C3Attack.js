// models/C3Attack.js
class C3Attack {
  constructor(data, factions = []) {
    this.id = data.ID;
    this.season = data.Season;
    this.name = data.Name;
    this.round = data.Round;
    this.winnerfaction_id = Number(data.FactionID_Winner) > 0
      ? Number(data.FactionID_Winner) : null;
    this.has_winner = this.winnerfaction_id !== null;
    this.factions = factions;
  }

  static factionIds(data) {
    // Read the existing attack's faction references without assuming role names.
    return [...new Set(Object.entries(data)
      .filter(([key]) => /^FactionID(?:_|$)/i.test(key))
      .map(([, value]) => Number(value))
      .filter((id) => Number.isSafeInteger(id) && id > 0))];
  }
}

module.exports = C3Attack;
