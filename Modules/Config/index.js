const Config = {};

Config.Application = {
    Version: '3.0.4',
    Name: 'ShowTrak',
    Port: 3000,
}

Config.Shared = {
    Version: Config.Application.Version,
}

module.exports = {
    Config,
}