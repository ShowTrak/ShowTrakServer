var checksum = require('checksum')



const Manager = {};

Manager.Checksum = async (filePath) => {
    return new Promise((resolve, reject) => {
        checksum.file(filePath, function (err, sum) {
            return resolve(sum);
        })
    })
}


module.exports = {
    Manager
};