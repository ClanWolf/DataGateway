// models/C3Attack.js
class C3Attack {
  constructor(data) {
    this.id = data.ID;
    this.season = data.Season;
    this.name = data.Name;
    this.round = data.Round;
  }
}

module.exports = C3Attack;
