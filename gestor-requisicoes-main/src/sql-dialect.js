/* Converte o dialeto SQLite usado pelo app para MySQL/MariaDB.
   Apenas construções conhecidas são traduzidas; o restante passa direto. */
function toMysql(sql) {
  return String(sql)
    .replace(/datetime\('now'\s*,\s*'localtime'\)/gi, 'NOW()')
    .replace(/date\('now'\s*,\s*'localtime'\)/gi, 'CURDATE()')
    .replace(/datetime\('now'\)/gi, 'UTC_TIMESTAMP()')
    .replace(/\s+COLLATE\s+NOCASE/gi, '')
    .replace(/INSERT\s+OR\s+IGNORE/gi, 'INSERT IGNORE')
    .replace(/INSERT\s+OR\s+REPLACE/gi, 'REPLACE');
}

module.exports = { toMysql };
