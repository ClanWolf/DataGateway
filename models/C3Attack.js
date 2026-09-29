// models/C3Attack.js
class C3Attack {
  constructor(data) {
    this.id = data.id || data.AttackId;
    this.name = data.name || data.Name;
    this.description = data.description || data.Description;
    this.seasonid = data.seasonid || data.SeasonId;
    this.factionid = data.factionid || data.FactionId;
    this.startdate = data.startdate || data.StartDate;
    this.enddate = data.enddate || data.EndDate;
    this.updated = data.updated || data.Updated;
  }
}

module.exports = C3Attack;
