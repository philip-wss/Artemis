/**
 * Course theme index — each file exports a course data object.
 * To add a new course theme, create a new .mjs file in this directory
 * and add it to the array below.
 */
import softwareEngineering from './software-engineering.mjs';
import algorithms from './algorithms.mjs';
import machineLearning from './machine-learning.mjs';
import databaseSystems from './database-systems.mjs';
import computerNetworks from './computer-networks.mjs';
import operatingSystems from './operating-systems.mjs';
import distributedSystems from './distributed-systems.mjs';
import cybersecurity from './cybersecurity.mjs';
import webDevelopment from './web-development.mjs';
import computerArchitecture from './computer-architecture.mjs';

export const ALL_COURSES = [
    softwareEngineering,
    algorithms,
    machineLearning,
    databaseSystems,
    computerNetworks,
    operatingSystems,
    distributedSystems,
    cybersecurity,
    webDevelopment,
    computerArchitecture,
];
