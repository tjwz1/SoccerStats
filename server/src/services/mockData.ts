export const MOCK_COMPETITIONS = [
  { id: 2021, name: "Premier League", code: "PL", emblem: "" },
  { id: 2014, name: "La Liga", code: "PD", emblem: "" },
  { id: 2002, name: "Bundesliga", code: "BL1", emblem: "" },
  { id: 2019, name: "Serie A", code: "SA", emblem: "" },
  { id: 2015, name: "Ligue 1", code: "FL1", emblem: "" },
];

export const MOCK_TEAMS = [
  { id: 57, name: "Arsenal FC", shortName: "Arsenal", crest: "", tla: "ARS" },
  { id: 61, name: "Chelsea FC", shortName: "Chelsea", crest: "", tla: "CHE" },
  { id: 64, name: "Liverpool FC", shortName: "Liverpool", crest: "", tla: "LIV" },
  { id: 65, name: "Manchester City FC", shortName: "Man City", crest: "", tla: "MCI" },
  { id: 66, name: "Manchester United FC", shortName: "Man Utd", crest: "", tla: "MUN" },
];

export const MOCK_LINEUP = {
  formation: "4-3-3",
  starters: [
    { id: 1, name: "David Raya", position: "Goalkeeper", nationality: "Spain", dateOfBirth: "1995-09-15", shirtNumber: 22, photo: null },
    { id: 2, name: "Ben White", position: "Defender", nationality: "England", dateOfBirth: "1997-10-08", shirtNumber: 4, photo: null },
    { id: 3, name: "William Saliba", position: "Defender", nationality: "France", dateOfBirth: "2001-03-24", shirtNumber: 12, photo: null },
    { id: 4, name: "Gabriel Magalhães", position: "Defender", nationality: "Brazil", dateOfBirth: "1997-12-19", shirtNumber: 6, photo: null },
    { id: 5, name: "Oleksandr Zinchenko", position: "Defender", nationality: "Ukraine", dateOfBirth: "1996-12-15", shirtNumber: 35, photo: null },
    { id: 6, name: "Thomas Partey", position: "Midfielder", nationality: "Ghana", dateOfBirth: "1993-06-13", shirtNumber: 5, photo: null },
    { id: 7, name: "Martin Ødegaard", position: "Midfielder", nationality: "Norway", dateOfBirth: "1998-12-17", shirtNumber: 8, photo: null },
    { id: 8, name: "Declan Rice", position: "Midfielder", nationality: "England", dateOfBirth: "1999-01-14", shirtNumber: 41, photo: null },
    { id: 9, name: "Bukayo Saka", position: "Attacker", nationality: "England", dateOfBirth: "2001-09-05", shirtNumber: 7, photo: null },
    { id: 10, name: "Gabriel Martinelli", position: "Attacker", nationality: "Brazil", dateOfBirth: "2001-06-18", shirtNumber: 11, photo: null },
    { id: 11, name: "Kai Havertz", position: "Attacker", nationality: "Germany", dateOfBirth: "1999-06-11", shirtNumber: 29, photo: null },
  ],
  bench: [
    { id: 12, name: "Aaron Ramsdale", position: "Goalkeeper", nationality: "England", dateOfBirth: "1998-05-14", shirtNumber: 1, photo: null },
    { id: 13, name: "Takehiro Tomiyasu", position: "Defender", nationality: "Japan", dateOfBirth: "1998-11-05", shirtNumber: 18, photo: null },
    { id: 14, name: "Jorginho", position: "Midfielder", nationality: "Italy", dateOfBirth: "1991-12-20", shirtNumber: 20, photo: null },
    { id: 15, name: "Fabio Vieira", position: "Midfielder", nationality: "Portugal", dateOfBirth: "2000-08-30", shirtNumber: 21, photo: null },
    { id: 16, name: "Gabriel Jesus", position: "Attacker", nationality: "Brazil", dateOfBirth: "1997-04-03", shirtNumber: 9, photo: null },
    { id: 17, name: "Leandro Trossard", position: "Attacker", nationality: "Belgium", dateOfBirth: "1994-12-04", shirtNumber: 19, photo: null },
    { id: 18, name: "Eddie Nketiah", position: "Attacker", nationality: "England", dateOfBirth: "1999-05-30", shirtNumber: 14, photo: null },
  ],
};

export const MOCK_PLAYER_STATS = {
  currentSeason: { appearances: 32, goals: 14, assists: 11, minutesPlayed: 2640 },
  career: [
    { season: "2024/25", team: "Arsenal FC", competition: "Premier League", appearances: 32, goals: 14, assists: 11 },
    { season: "2024/25", team: "Arsenal FC", competition: "Champions League", appearances: 8, goals: 3, assists: 2 },
    { season: "2023/24", team: "Arsenal FC", competition: "Premier League", appearances: 35, goals: 16, assists: 9 },
    { season: "2022/23", team: "Arsenal FC", competition: "Premier League", appearances: 38, goals: 14, assists: 11 },
    { season: "2021/22", team: "Arsenal FC", competition: "Premier League", appearances: 35, goals: 11, assists: 7 },
    { season: "2020/21", team: "Arsenal FC", competition: "Premier League", appearances: 32, goals: 5, assists: 4 },
  ],
  totals: { appearances: 180, goals: 63, assists: 44 },
};
