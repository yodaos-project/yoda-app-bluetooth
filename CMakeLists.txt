cmake_minimum_required(VERSION 3.0)
project(yodaos-bluetooth CXX)
set(CMAKE_CXX_STANDARD 11)

set(APP_INSTALL_DIR "${CMAKE_INSTALL_DIR}/opt/apps")

# MARK: - bluetooth
install(DIRECTORY ./bluetooth
  DESTINATION ${APP_INSTALL_DIR}
  USE_SOURCE_PERMISSIONS)

# MARK: - bluetooth-music
install(DIRECTORY ./bluetooth-music
  DESTINATION ${APP_INSTALL_DIR}
  USE_SOURCE_PERMISSIONS)
