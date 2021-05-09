const { Model, DataTypes } = require('sequelize');

module.exports = sequelize => {
  class Triple extends Model {}
  Triple.init({
    subject   : DataTypes.STRING,
    predicate : DataTypes.STRING,
    object    : DataTypes.STRING,
  }, { sequelize, tableName: 'graph' })
};
