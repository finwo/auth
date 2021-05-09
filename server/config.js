module.exports = {
  port: parseFloat(process.env.PORT || 8080),
  db  : process.env.DATABASE_URL || 'sqlite::memory:',
};
